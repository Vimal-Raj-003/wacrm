"use client";

import {
  useState,
  useRef,
  useCallback,
  useEffect,
  useMemo,
  KeyboardEvent,
} from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import {
  Send,
  LayoutTemplate,
  Paperclip,
  Image as ImageIcon,
  Video,
  FileText,
  FileAudio,
  Mic,
  Square,
  X,
  Loader2,
  Sparkles,
  Plus,
  MessageSquareDashed,
  Zap,
  Eye,
  AlertTriangle,
  CheckCircle2,
  Wand2,
  Link2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { GatedButton } from "@/components/ui/gated-button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useCan } from "@/hooks/use-can";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import {
  uploadAccountMedia,
  deleteAccountMedia,
  MEDIA_MAX_BYTES_BY_KIND,
} from "@/lib/storage/upload-media";
import { ReplyQuote } from "./reply-quote";
import { useTranslations } from "next-intl";
import {
  InteractiveBuilder,
  blankButtonsPayload,
} from "@/components/interactive/interactive-builder";
import { validateInteractivePayload } from "@/lib/whatsapp/interactive";
import type {
  Contact,
  InteractiveMessagePayload,
  MessageTemplate,
  QuickReply,
} from "@/types";
import type { TemplateSendValues } from "./template-picker";
import {
  extractTemplateVariables,
  extractVariableIndices,
} from "@/lib/whatsapp/template-validators";
import { QuickReplyPicker } from "./quick-reply-picker";
import {
  analyzeOutgoingMessage,
  estimateMobileLines,
  optimizeMessageSpacing,
  splitForNoReadMore,
} from "@/lib/whatsapp/message-formatting";
import { basenameFromUrl } from "@/lib/media/filename";

/** Media content types an agent can send from the composer. */
export type ComposerMediaKind = "image" | "video" | "document" | "audio";

/** Supabase Storage bucket holding agent-sent chat attachments (migration 023). */
export const CHAT_MEDIA_BUCKET = "chat-media";

/** Meta caps media captions at 1024 chars. Enforced here and in the send route. */
export const MEDIA_CAPTION_MAX = 1024;

/** Hard cap on a single voice recording so it can't blow the upload/
 *  transcode limits — auto-stops the recorder when reached. */
const MAX_RECORDING_SECONDS = 5 * 60;

export interface SendMediaPayload {
  kind: ComposerMediaKind;
  /** Public chat-media URL Meta fetches at send time. */
  mediaUrl: string;
  /** Storage object path — lets the caller GC the object if the send fails. */
  path: string;
  /** Optional caption (image/video/document only). */
  caption?: string;
  /** Original file name — surfaced to the recipient for documents. */
  filename?: string;
  /**
   * When true and caption exceeds 2 mobile lines, send the attachment cleanly
   * without a long caption and follow up with short <=4-line text bubbles so
   * WhatsApp never collapses the text behind "Read more".
   */
  separateLongCaption?: boolean;
  replyToId?: string;
}

interface ReplyDraft {
  /** Internal UUID of the message being replied to — sent back through onSend. */
  id: string;
  authorLabel: string;
  preview: string;
}

// Mirrors the chat-media bucket's allowed_mime_types (migration 023) for
// the file picker so unsupported files are rejected before upload rather
// than failing with a confusing Storage error. Audio has no picker — it's
// captured via the recorder.
const PICKER_ACCEPT: Record<"image" | "video" | "document" | "audio", string> = {
  image: "image/png,image/jpeg,image/webp",
  video: "video/mp4,video/3gpp",
  document:
    "application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation,text/plain",
  audio:
    "audio/mpeg,audio/ogg,audio/mp4,audio/aac,audio/amr,.mp3,.ogg,.m4a,.aac,.amr",
};

const AUDIO_MIME_BY_EXT: Record<string, string> = {
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  opus: "audio/ogg",
  m4a: "audio/mp4",
  mp4: "audio/mp4",
  aac: "audio/aac",
  amr: "audio/amr",
};

const ALLOWED_AUDIO_MIMES = new Set([
  "audio/ogg",
  "audio/mpeg",
  "audio/aac",
  "audio/mp4",
  "audio/amr",
]);

/**
 * Windows/macOS browsers often report non-canonical MIME types for audio files
 * (e.g. `audio/x-m4a`, `audio/mp3`, or empty string). Normalize to the exact
 * MIME types allowed by the `chat-media` Supabase bucket and Meta Cloud API.
 */
function normalizeAudioFile(file: File): File {
  const lowerType = (file.type || "").toLowerCase().split(";")[0].trim();
  if (ALLOWED_AUDIO_MIMES.has(lowerType)) return file;
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  const canonical =
    AUDIO_MIME_BY_EXT[ext] ??
    (lowerType === "audio/x-m4a"
      ? "audio/mp4"
      : lowerType === "audio/mp3"
        ? "audio/mpeg"
        : "");
  if (!canonical) return file;
  return new File([file], file.name, { type: canonical });
}

interface MediaDraft {
  kind: ComposerMediaKind;
  mediaUrl: string;
  /** Storage path — used to GC the object if the draft is discarded. */
  path: string;
  filename: string;
  caption: string;
}

interface MessageComposerProps {
  conversationId: string;
  contact?: Contact | null;
  sessionExpired: boolean;
  onSend: (
    text: string,
    replyToId?: string,
    options?: { previewUrl?: boolean; noReadMore?: boolean },
  ) => void;
  onSendMedia: (payload: SendMediaPayload) => void;
  onSendInteractive: (payload: InteractiveMessagePayload, replyToId?: string) => void;
  onSendTemplate?: (template: MessageTemplate, values: TemplateSendValues) => void;
  onOpenTemplates: () => void;
  replyTo?: ReplyDraft | null;
  onClearReply?: () => void;
}

const QUICK_START_TEMPLATE_KEY = "wacrm:quick-start-template";
const NO_READ_MORE_KEY = "wacrm:no-read-more-mode";

/**
 * Approved templates eligible for WhatsApp-style direct typing when a
 * chat is brand new or outside the 24-hour customer service window:
 * 1 or 2 body variables, no required text-header variable or dynamic URL
 * button variable.
 */
function isQuickStartEligible(tpl: MessageTemplate): boolean {
  const bodyVars = extractTemplateVariables(tpl.body_text);
  if (bodyVars.length < 1 || bodyVars.length > 2) return false;
  if (
    tpl.header_type === "text" &&
    tpl.header_content &&
    extractTemplateVariables(tpl.header_content).length > 0
  ) {
    return false;
  }
  if (
    tpl.header_type &&
    tpl.header_type !== "text" &&
    tpl.header_type !== "document" &&
    !tpl.header_media_url
  ) {
    return false;
  }
  const hasDynamicUrl = (tpl.buttons ?? []).some(
    (b) => b.type === "URL" && extractVariableIndices(b.url).length > 0,
  );
  if (hasDynamicUrl) return false;
  return true;
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/** Worker that encodes mic input to Ogg/Opus entirely in the browser
 *  (vendored from opus-recorder into /public). Recording client-side in a
 *  Meta-accepted format means no server ffmpeg / transcode step. */
const OPUS_ENCODER_PATH = "/opus/encoderWorker.min.js";

export function MessageComposer({
  conversationId,
  contact,
  sessionExpired,
  onSend,
  onSendMedia,
  onSendInteractive,
  onSendTemplate,
  onOpenTemplates,
  replyTo,
  onClearReply,
}: MessageComposerProps) {
  const t = useTranslations("Inbox.composer");
  const tGate = useTranslations("GatedButton");

  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Enter-to-send only on devices with a mouse/keyboard (fine pointer).
  // On touch devices (phones) Enter inserts a newline and the Send button
  // is the only way to send — there's no practical Shift+Enter on a phone,
  // so intercepting Enter there blocks multi-line messages.
  const [enterSends, setEnterSends] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(pointer: fine)");
    const apply = () => setEnterSends(mq.matches);
    apply();
    mq.addEventListener?.("change", apply);
    return () => mq.removeEventListener?.("change", apply);
  }, []);

  // Interactive-message builder dialog + quick-reply picker.
  const [interactiveOpen, setInteractiveOpen] = useState(false);
  const [interactivePayload, setInteractivePayload] =
    useState<InteractiveMessagePayload>(blankButtonsPayload);
  const [savingQuickReply, setSavingQuickReply] = useState(false);
  const [quickReplyOpen, setQuickReplyOpen] = useState(false);
  // Pre-send message preview dialog — lets agents check WhatsApp fold
  // risk ("Read more") and formatting before sending.
  const [previewOpen, setPreviewOpen] = useState(false);
  // Link preview card toggle for free-form text messages (defaults OFF so
  // multi-link messages do not show a single preview card or fold earlier).
  const [previewUrl, setPreviewUrl] = useState(false);
  // "No 'Read more' mode" — automatically sends long free-form messages in
  // clean sequential <=4-line bubbles (and separates long PDF captions) so
  // WhatsApp Android renders 100% of the message without any "Read more" fold.
  const [noReadMoreMode, setNoReadMoreMode] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    try {
      const saved = localStorage.getItem(NO_READ_MORE_KEY);
      return saved === null ? false : saved === "true";
    } catch {
      return false;
    }
  });
  const toggleNoReadMore = useCallback(() => {
    setNoReadMoreMode((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(NO_READ_MORE_KEY, String(next));
      } catch {
        // ignore storage errors
      }
      return next;
    });
  }, []);

  // Media attachment state. `draft` holds an uploaded-but-not-yet-sent
  // attachment; `busy` covers the upload/transcode window.
  const [draft, setDraft] = useState<MediaDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const videoInputRef = useRef<HTMLInputElement>(null);
  const documentInputRef = useRef<HTMLInputElement>(null);
  const audioInputRef = useRef<HTMLInputElement>(null);
  // When true, stopping an active voice recording sends it immediately instead
  // of staging it in the preview bar first.
  const autoSendRecordingRef = useRef(false);
  // Mirror of `draft` for the unmount cleanup, which can't read render
  // state. Kept in sync below so navigating away with a staged-but-unsent
  // attachment GCs the orphaned object.
  const draftRef = useRef<MediaDraft | null>(null);
  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  // Best-effort GC of a staged object the user never sent. Fire-and-forget.
  const removeStaged = useCallback((path: string | undefined) => {
    if (!path) return;
    void deleteAccountMedia(CHAT_MEDIA_BUCKET, path).catch(() => {});
  }, []);

  // Voice recording state. The recorder encodes Ogg/Opus in-browser
  // (opus-recorder) so there's no server-side transcode.
  const [recording, setRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const recorderRef = useRef<import("opus-recorder").default | null>(null);
  const cancelledRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Viewers (read-only role) can browse the inbox but never send.
  // For solo users this is always true — single-owner accounts pass
  // every capability — so the disabled branch is a no-op there.
  const canSend = useCan("send-messages");
  const readOnly = !canSend;

  // Approved dynamic templates that let an agent type & send directly
  // in a brand-new chat (or outside the 24-hour window) without leaving
  // the composer — 100% compliant with Meta's Cloud API template rule.
  const [quickTemplates, setQuickTemplates] = useState<MessageTemplate[]>([]);
  const [selectedQuickTemplateId, setSelectedQuickTemplateId] = useState<string>("");

  useEffect(() => {
    if (!sessionExpired || readOnly || !onSendTemplate) return;
    let cancelled = false;
    (async () => {
      const supabase = createClient();
      const { data } = await supabase
        .from("message_templates")
        .select("*")
        .eq("status", "APPROVED")
        .order("created_at", { ascending: false });
      if (cancelled) return;
      const eligible = ((data as MessageTemplate[]) ?? []).filter(
        isQuickStartEligible,
      );
      setQuickTemplates(eligible);
      if (eligible.length > 0) {
        let saved = "";
        try {
          saved = localStorage.getItem(QUICK_START_TEMPLATE_KEY) ?? "";
        } catch {
          // ignore storage errors
        }
        const match =
          eligible.find((tpl) => tpl.id === saved) ??
          eligible.find((tpl) => !tpl.header_type || tpl.header_type === "text") ??
          eligible[0];
        setSelectedQuickTemplateId(match.id);
      } else {
        setSelectedQuickTemplateId("");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionExpired, readOnly, onSendTemplate]);

  const activeQuickTemplate = useMemo(
    () =>
      sessionExpired && onSendTemplate
        ? (quickTemplates.find((tpl) => tpl.id === selectedQuickTemplateId) ??
          null)
        : null,
    [sessionExpired, onSendTemplate, quickTemplates, selectedQuickTemplateId],
  );

  const canQuickStartViaTemplate = Boolean(activeQuickTemplate && !readOnly);
  const canAttachPdfForQuickTemplate = Boolean(
    canQuickStartViaTemplate && activeQuickTemplate?.header_type === "document",
  );

  // Media (like free-form text) is only allowed inside the 24h window,
  // except PDF upload when a Document-Header Quick-Start template is active.
  const inputsDisabled = readOnly || sessionExpired;
  const textInputDisabled =
    readOnly || (sessionExpired && !canQuickStartViaTemplate);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  // Tear down any live recording + timer on unmount so a mid-record
  // navigation doesn't leak the mic, and GC a staged-but-unsent
  // attachment so it doesn't orphan in the bucket.
  useEffect(() => {
    return () => {
      clearTimer();
      cancelledRef.current = true;
      // stop() releases the mic stream + audio context inside opus-recorder.
      void recorderRef.current?.stop().catch(() => {});
      removeStaged(draftRef.current?.path);
    };
  }, [clearTimer, removeStaged]);

  const adjustHeight = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    // Max 4 lines (~96px)
    el.style.height = `${Math.min(el.scrollHeight, 96)}px`;
  }, []);

  const handleSend = useCallback(async () => {
    const trimmed = text.trim();
    if (!trimmed || sending || readOnly) return;
    if (sessionExpired && !activeQuickTemplate) return;

    setSending(true);
    try {
      if (sessionExpired && activeQuickTemplate && onSendTemplate) {
        const bodyVars = extractTemplateVariables(activeQuickTemplate.body_text);
        // 1 variable -> typed text; 2 variables -> [contact name, typed text].
        const bodyValues =
          bodyVars.length === 1
            ? [trimmed]
            : [contact?.name?.trim() || "Customer", trimmed];
        onSendTemplate(activeQuickTemplate, {
          body: bodyValues,
          ...(activeQuickTemplate.header_type === "document" &&
          activeQuickTemplate.header_media_url
            ? {
                headerMediaUrl: activeQuickTemplate.header_media_url,
                headerDocumentFilename:
                  basenameFromUrl(activeQuickTemplate.header_media_url) ||
                  "Document.pdf",
              }
            : {}),
        });
      } else {
        onSend(trimmed, replyTo?.id, { previewUrl, noReadMore: noReadMoreMode });
      }
      setText("");
      setPreviewOpen(false);
      if (textareaRef.current) {
        textareaRef.current.style.height = "auto";
      }
    } finally {
      setSending(false);
    }
  }, [
    text,
    sending,
    readOnly,
    sessionExpired,
    activeQuickTemplate,
    onSendTemplate,
    contact?.name,
    onSend,
    replyTo?.id,
    previewUrl,
    noReadMoreMode,
  ]);

  const activeMessageContext =
    sessionExpired && activeQuickTemplate
      ? activeQuickTemplate.category === "Marketing"
        ? "marketing_template"
        : "utility_template"
      : "text";

  const formattingAnalysis = analyzeOutgoingMessage(text, {
    context: activeMessageContext,
    hasMediaHeader: Boolean(
      sessionExpired &&
        activeQuickTemplate?.header_type &&
        activeQuickTemplate.header_type !== "text",
    ),
    previewUrl,
  });

  const needsFormattingFix =
    formattingAnalysis.hasExcessiveBlankLines ||
    formattingAnalysis.hasMarkdownLinks ||
    (formattingAnalysis.hasGreetingBlankLine &&
      formattingAnalysis.foldLineLimit <= 5);

  const handleOptimizeSpacing = useCallback(() => {
    setText((prev) =>
      optimizeMessageSpacing(prev, {
        compactGreeting: formattingAnalysis.foldLineLimit <= 5,
      }),
    );
    requestAnimationFrame(() => adjustHeight());
  }, [adjustHeight, formattingAnalysis.foldLineLimit]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey && enterSends) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend, enterSends]
  );

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      setText(e.target.value);
      adjustHeight();
    },
    [adjustHeight]
  );

  // Ask the AI assistant for a suggested reply and drop it into the
  // composer for the agent to edit + send. Read-only server-side —
  // nothing is sent until the agent hits Send.
  const handleDraft = useCallback(async () => {
    if (drafting) return;
    setDrafting(true);
    try {
      const res = await fetch("/api/ai/draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversation_id: conversationId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (data.code === "ai_not_configured") {
          toast.error(t("aiNotConfigured"));
        } else {
          toast.error(data.error ?? t("draftFailed"));
        }
        return;
      }
      const draftText = typeof data.draft === "string" ? data.draft.trim() : "";
      if (!draftText) {
        toast.error(t("draftEmpty"));
        return;
      }
      setText(draftText);
      // Let the textarea grow to fit and drop the cursor at the end so
      // the agent can tweak immediately.
      requestAnimationFrame(() => {
        adjustHeight();
        const el = textareaRef.current;
        if (el) {
          el.focus();
          el.setSelectionRange(el.value.length, el.value.length);
        }
      });
    } catch {
      toast.error(t("aiUnreachable"));
    } finally {
      setDrafting(false);
    }
  }, [drafting, conversationId, adjustHeight, t]);

  // ---- Interactive message + quick replies --------------------------

  const openInteractiveBuilder = useCallback(
    (seed?: InteractiveMessagePayload) => {
      setInteractivePayload(seed ?? blankButtonsPayload());
      setInteractiveOpen(true);
    },
    [],
  );

  const sendInteractive = useCallback(() => {
    const result = validateInteractivePayload(interactivePayload);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    onSendInteractive(interactivePayload, replyTo?.id);
    setInteractiveOpen(false);
    onClearReply?.();
  }, [interactivePayload, onSendInteractive, replyTo?.id, onClearReply]);

  // Persist the current builder payload as a reusable interactive snippet.
  const saveAsQuickReply = useCallback(async () => {
    const result = validateInteractivePayload(interactivePayload);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    const title = window
      .prompt(t("quickReplyNamePrompt"))
      ?.trim();
    if (!title) return;
    setSavingQuickReply(true);
    try {
      const res = await fetch("/api/quick-replies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          kind: "interactive",
          interactive_payload: interactivePayload,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? t("quickReplySaveError"));
        return;
      }
      toast.success(t("quickReplySaved"));
    } catch {
      toast.error(t("quickReplySaveError"));
    } finally {
      setSavingQuickReply(false);
    }
  }, [interactivePayload, t]);

  // A picked quick reply: text fills the composer; interactive opens the
  // builder pre-filled so the agent can tweak before sending.
  const handlePickQuickReply = useCallback(
    (qr: QuickReply) => {
      setQuickReplyOpen(false);
      if (qr.kind === "interactive" && qr.interactive_payload) {
        openInteractiveBuilder(qr.interactive_payload);
        return;
      }
      const body = qr.content_text ?? "";
      // Separate the snippet from any existing draft with a newline so the
      // words don't run together ("Thanks" + "we'll…" → "Thankswe'll…").
      setText((prev) =>
        prev && !/\s$/.test(prev) ? `${prev}\n${body}` : `${prev}${body}`,
      );
      requestAnimationFrame(() => {
        adjustHeight();
        const el = textareaRef.current;
        if (el) {
          el.focus();
          el.setSelectionRange(el.value.length, el.value.length);
        }
      });
    },
    [openInteractiveBuilder, adjustHeight],
  );

  // Upload a captured file to chat-media and stage it as a draft.
  const stageUpload = useCallback(
    async (kind: ComposerMediaKind, rawFile: File) => {
      const file = kind === "audio" ? normalizeAudioFile(rawFile) : rawFile;
      // Per-kind ceiling mirrors Meta's caps (image 5 MB, etc.) so we
      // reject before upload rather than orphaning an object that Meta
      // would then refuse at send.
      const max = MEDIA_MAX_BYTES_BY_KIND[kind];
      if (file.size > max) {
        toast.error(
          t("fileTooLarge", {
            size: (file.size / 1024 / 1024).toFixed(1),
            kind: t(`mediaKind.${kind}`),
            max: Math.round(max / 1024 / 1024),
          }),
        );
        return;
      }
      setBusy(true);
      try {
        const { publicUrl, path } = await uploadAccountMedia(CHAT_MEDIA_BUCKET, file);
        // Replacing an existing draft? GC the previous object first.
        removeStaged(draftRef.current?.path);
        setDraft({ kind, mediaUrl: publicUrl, path, filename: file.name, caption: "" });
      } catch (err) {
        toast.error(err instanceof Error ? err.message : t("uploadFailed"));
      } finally {
        setBusy(false);
      }
    },
    [removeStaged, t],
  );

  const handlePicked = useCallback(
    (kind: "image" | "video" | "document" | "audio", file: File | undefined) => {
      if (file) void stageUpload(kind, file);
    },
    [stageUpload],
  );

  // ---- Voice recording (client-side Ogg/Opus, no server transcode) ---

  // The encoded Ogg/Opus file from opus-recorder → upload as an audio
  // draft (or send immediately when Stop & Send was clicked). WhatsApp
  // renders Ogg/Opus as a playable voice note.
  const finalizeRecording = useCallback(
    async (bytes: Uint8Array) => {
      const shouldSendNow = autoSendRecordingRef.current;
      autoSendRecordingRef.current = false;
      // Uint8Array is a valid BlobPart at runtime; the cast sidesteps the
      // lib.dom ArrayBufferLike-vs-ArrayBuffer generic mismatch.
      const file = new File([bytes as unknown as BlobPart], `voice-${Date.now()}.ogg`, {
        type: "audio/ogg",
      });
      if (file.size === 0) return; // cancelled / empty take
      if (file.size > MEDIA_MAX_BYTES_BY_KIND.audio) {
        toast.error(t("recordingTooLong"));
        return;
      }
      setBusy(true);
      try {
        const { publicUrl, path } = await uploadAccountMedia(CHAT_MEDIA_BUCKET, file);
        if (shouldSendNow) {
          onSendMedia({
            kind: "audio",
            mediaUrl: publicUrl,
            path,
            replyToId: replyTo?.id,
          });
          onClearReply?.();
        } else {
          removeStaged(draftRef.current?.path);
          setDraft({ kind: "audio", mediaUrl: publicUrl, path, filename: file.name, caption: "" });
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : t("uploadFailed"));
      } finally {
        setBusy(false);
      }
    },
    [removeStaged, onSendMedia, replyTo?.id, onClearReply, t],
  );

  const startRecording = useCallback(async () => {
    if (readOnly || busy || recording) return;
    if (sessionExpired) {
      toast.error(
        "Voice notes and audio files require an active 24-hour chat. Send an approved template first — once the customer replies, you can record and send audio.",
      );
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof AudioContext === "undefined") {
      toast.error(t("recordingUnsupported"));
      return;
    }
    try {
      // Lazy-load the encoder (≈400 KB worker) only when the user records,
      // keeping it out of the main bundle.
      const { default: Recorder } = await import("opus-recorder");
      const recorder = new Recorder({
        encoderPath: OPUS_ENCODER_PATH,
        numberOfChannels: 1,
        encoderApplication: 2048, // VOIP — tuned for speech
        encoderSampleRate: 48000,
        streamPages: false, // one callback with the complete file on stop
      });
      cancelledRef.current = false;
      autoSendRecordingRef.current = false;
      recorder.ondataavailable = (bytes) => {
        if (cancelledRef.current) return;
        void finalizeRecording(bytes);
      };
      recorderRef.current = recorder;
      await recorder.start();
      setRecording(true);
      setRecordSeconds(0);
      timerRef.current = setInterval(() => setRecordSeconds((s) => s + 1), 1000);
    } catch {
      void recorderRef.current?.stop().catch(() => {});
      recorderRef.current = null;
      toast.error(t("microphoneDenied"));
    }
  }, [readOnly, sessionExpired, busy, recording, finalizeRecording, t]);

  const stopRecording = useCallback(() => {
    autoSendRecordingRef.current = false;
    clearTimer();
    setRecording(false);
    void recorderRef.current?.stop().catch(() => {});
  }, [clearTimer]);

  const stopAndSendRecording = useCallback(() => {
    autoSendRecordingRef.current = true;
    clearTimer();
    setRecording(false);
    void recorderRef.current?.stop().catch(() => {});
  }, [clearTimer]);

  const cancelRecording = useCallback(() => {
    cancelledRef.current = true;
    clearTimer();
    setRecording(false);
    void recorderRef.current?.stop().catch(() => {});
  }, [clearTimer]);

  // Auto-stop at the cap so a forgotten recording can't blow the
  // upload size limit.
  useEffect(() => {
    if (recording && recordSeconds >= MAX_RECORDING_SECONDS) {
      stopRecording();
    }
  }, [recording, recordSeconds, stopRecording]);

  // ---- Draft send / discard -----------------------------------------

  const sendDraft = useCallback(() => {
    if (!draft || busy) return;
    if (
      sessionExpired &&
      draft.kind === "document" &&
      activeQuickTemplate?.header_type === "document" &&
      onSendTemplate
    ) {
      const bodyVars = extractTemplateVariables(activeQuickTemplate.body_text);
      const captionText =
        draft.caption.trim() || `Please find ${draft.filename} attached.`;
      const bodyValues =
        bodyVars.length === 1
          ? [captionText]
          : [contact?.name?.trim() || "Customer", captionText];
      onSendTemplate(activeQuickTemplate, {
        body: bodyValues,
        headerMediaUrl: draft.mediaUrl,
        headerDocumentFilename: draft.filename,
      });
      setDraft(null);
      onClearReply?.();
      return;
    }
    const trimmedCaption =
      draft.kind === "audio" ? undefined : draft.caption.trim() || undefined;
    const separateLongCaption = Boolean(
      noReadMoreMode &&
        trimmedCaption &&
        (estimateMobileLines(trimmedCaption) > 2 || trimmedCaption.length > 85),
    );
    onSendMedia({
      kind: draft.kind,
      mediaUrl: draft.mediaUrl,
      path: draft.path,
      // Audio takes no caption (Meta rejects it). Everything else: the
      // trimmed caption, or undefined when blank.
      caption: trimmedCaption,
      filename: draft.kind === "document" ? draft.filename : undefined,
      separateLongCaption,
      replyToId: replyTo?.id,
    });
    // The object is now owned by the sent message — clear without GC.
    setDraft(null);
    onClearReply?.();
  }, [
    draft,
    busy,
    sessionExpired,
    activeQuickTemplate,
    onSendTemplate,
    contact?.name,
    onSendMedia,
    noReadMoreMode,
    replyTo?.id,
    onClearReply,
  ]);

  // Discard GCs the staged object — it was uploaded but never sent.
  const discardDraft = useCallback(() => {
    removeStaged(draft?.path);
    setDraft(null);
  }, [draft?.path, removeStaged]);

  const setCaption = useCallback((caption: string) => {
    setDraft((d) => (d ? { ...d, caption } : d));
  }, []);

  // ---- Render --------------------------------------------------------

  return (
    <div className="border-t border-border bg-card p-3">
      {replyTo && (
        <div className="mb-2">
          <ReplyQuote
            authorLabel={replyTo.authorLabel}
            preview={replyTo.preview}
            onDismiss={onClearReply}
          />
        </div>
      )}
      {sessionExpired && (
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2">
          {activeQuickTemplate ? (
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2 text-xs text-amber-300">
              <span>
                24h window closed — type below to send via approved template:
              </span>
              <select
                value={selectedQuickTemplateId}
                onChange={(e) => {
                  const id = e.target.value;
                  setSelectedQuickTemplateId(id);
                  try {
                    localStorage.setItem(QUICK_START_TEMPLATE_KEY, id);
                  } catch {
                    // ignore
                  }
                }}
                aria-label="Quick-start template"
                className="h-7 max-w-[200px] rounded border border-amber-500/40 bg-background/80 px-2 text-xs text-foreground outline-none"
              >
                {quickTemplates.map((tpl) => (
                  <option key={tpl.id} value={tpl.id}>
                    {tpl.name}
                    {tpl.header_type === "document" ? " (PDF)" : ""}
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <p className="min-w-0 flex-1 text-xs text-amber-300">
              WhatsApp requires an approved template for new chats / outside 24h.
              Create a 1-click Quick-Start Template (e.g.{" "}
              <code className="rounded bg-amber-500/20 px-1">
                {"Hi {{1}}, {{2}}"}
              </code>
              ) to type &amp; send directly here, or pick any approved template.
            </p>
          )}
          <div className="flex shrink-0 items-center gap-1.5">
            {!activeQuickTemplate && (
              <Link
                href="/settings?tab=templates&preset=quick_chat"
                className="inline-flex h-7 items-center gap-1 rounded-md border border-amber-500/40 bg-background/60 px-2.5 text-xs font-medium text-amber-300 hover:bg-background"
              >
                <Plus className="h-3 w-3" />
                Create Quick-Start Template
              </Link>
            )}
            <Button
              variant="default"
              size="sm"
              className="h-7 bg-primary text-xs text-primary-foreground hover:bg-primary/90"
              onClick={onOpenTemplates}
            >
              <LayoutTemplate className="mr-1 h-3 w-3" />
              {activeQuickTemplate ? "All Templates" : t("templates")}
            </Button>
          </div>
        </div>
      )}

      {/* Hidden file inputs driven by the attach menu. */}
      <input
        ref={imageInputRef}
        type="file"
        accept={PICKER_ACCEPT.image}
        className="hidden"
        onChange={(e) => {
          handlePicked("image", e.target.files?.[0]);
          e.target.value = "";
        }}
      />
      <input
        ref={videoInputRef}
        type="file"
        accept={PICKER_ACCEPT.video}
        className="hidden"
        onChange={(e) => {
          handlePicked("video", e.target.files?.[0]);
          e.target.value = "";
        }}
      />
      <input
        ref={documentInputRef}
        type="file"
        accept={PICKER_ACCEPT.document}
        className="hidden"
        onChange={(e) => {
          handlePicked("document", e.target.files?.[0]);
          e.target.value = "";
        }}
      />
      <input
        ref={audioInputRef}
        type="file"
        accept={PICKER_ACCEPT.audio}
        className="hidden"
        onChange={(e) => {
          handlePicked("audio", e.target.files?.[0]);
          e.target.value = "";
        }}
      />

      {draft ? (
        <MediaDraftPreview
          draft={draft}
          busy={busy}
          readOnly={readOnly}
          noReadMoreMode={noReadMoreMode}
          onCaptionChange={setCaption}
          onDiscard={discardDraft}
          onSend={sendDraft}
          t={t}
        />
      ) : recording ? (
        // Recording bar — replaces the composer while the mic is live.
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-2.5">
          <span className="flex h-2.5 w-2.5 shrink-0 animate-pulse rounded-full bg-red-500" />
          <span className="flex-1 text-sm font-medium text-foreground">
            {t("recording", { current: formatDuration(recordSeconds), max: formatDuration(MAX_RECORDING_SECONDS) })}
          </span>
          <button
            type="button"
            onClick={cancelRecording}
            className="rounded-md px-2.5 py-1 text-xs text-muted-foreground hover:bg-card hover:text-foreground"
          >
            {t("cancel")}
          </button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={stopRecording}
            className="h-8 gap-1 border-border px-2.5 text-xs"
            title={t("stopAndAttach")}
          >
            <Square className="h-3.5 w-3.5" />
            Preview
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={stopAndSendRecording}
            className="h-8 gap-1 bg-primary px-3 text-xs text-primary-foreground hover:bg-primary/90"
            title="Stop recording and send voice note immediately"
          >
            <Send className="h-3.5 w-3.5" />
            Send Voice
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-end gap-2">
          {/* Action buttons. On mobile this group wraps to its own row
              below the textarea (basis-full + order-2) so the input gets
              the full width; on sm+ it sits inline before the textarea. */}
          <div className="order-2 flex basis-full items-end gap-2 sm:order-1 sm:basis-auto">
          {/* Attach menu — photo / video / document / voice. */}
          <DropdownMenu>
            <DropdownMenuTrigger
              disabled={(inputsDisabled && !canAttachPdfForQuickTemplate) || busy}
              title={
                readOnly
                  ? t("readOnlyTitle")
                  : inputsDisabled && !canAttachPdfForQuickTemplate
                    ? undefined
                    : t("attachMedia")
              }
              className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md p-0 text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Paperclip className="h-4 w-4" />
              )}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="border-border bg-popover">
              {!sessionExpired && (
                <>
                  <DropdownMenuItem onClick={() => imageInputRef.current?.click()}>
                    <ImageIcon className="mr-2 h-4 w-4" />
                    {t("photo")}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => videoInputRef.current?.click()}>
                    <Video className="mr-2 h-4 w-4" />
                    {t("video")}
                  </DropdownMenuItem>
                </>
              )}
              <DropdownMenuItem onClick={() => documentInputRef.current?.click()}>
                <FileText className="mr-2 h-4 w-4" />
                {t("document")}
              </DropdownMenuItem>
              {!sessionExpired && (
                <>
                  <DropdownMenuItem onClick={() => audioInputRef.current?.click()}>
                    <FileAudio className="mr-2 h-4 w-4" />
                    Audio File (.mp3 / .ogg / .m4a)
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => void startRecording()}>
                    <Mic className="mr-2 h-4 w-4" />
                    {t("voiceNote")}
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>

          {/* + menu — interactive messages + quick replies. Gated on the
              24h window like free-form text (interactive requires it). */}
          <DropdownMenu>
            <DropdownMenuTrigger
              disabled={inputsDisabled}
              title={
                readOnly
                  ? t("readOnlyTitle")
                  : inputsDisabled
                    ? undefined
                    : t("moreActions")
              }
              className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md p-0 text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Plus className="h-4 w-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="border-border bg-popover">
              <DropdownMenuItem onClick={() => openInteractiveBuilder()}>
                <MessageSquareDashed className="mr-2 h-4 w-4" />
                {t("interactiveMessage")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setQuickReplyOpen(true)}>
                <Zap className="mr-2 h-4 w-4" />
                {t("quickReplies")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <GatedButton
            variant="ghost"
            size="sm"
            canAct={!readOnly}
            gateReason={tGate("reasons.sendMessages")}
            title={readOnly ? undefined : t("sendTemplate")}
            className="h-9 w-9 shrink-0 p-0 text-muted-foreground hover:text-foreground"
            onClick={onOpenTemplates}
          >
            <LayoutTemplate className="h-4 w-4" />
          </GatedButton>

          <GatedButton
            variant="ghost"
            size="sm"
            canAct={!readOnly}
            gateReason={tGate("reasons.sendMessages")}
            disabled={drafting}
            title={readOnly ? undefined : t("draftWithAI")}
            className="h-9 w-9 shrink-0 p-0 text-muted-foreground hover:text-primary"
            onClick={handleDraft}
          >
            {drafting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Sparkles className="h-4 w-4" />
            )}
          </GatedButton>
          </div>

          <textarea
            ref={textareaRef}
            value={text}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            placeholder={
              readOnly
                ? t("readOnlyPlaceholder")
                : sessionExpired
                  ? activeQuickTemplate
                    ? `Type your message (sent via approved template "${activeQuickTemplate.name}")...`
                    : t("sessionExpiredPlaceholder")
                  : t("typeMessagePlaceholder")
            }
            disabled={textInputDisabled}
            rows={1}
            // Textarea keeps its own inline title — the GatedButton
            // wrapping pattern doesn't apply to non-button inputs.
            // The placeholder text also surfaces the read-only state.
            title={readOnly ? t("readOnlyTitle") : undefined}
            className={cn(
              "order-1 min-w-0 flex-1 resize-none rounded-xl border border-border bg-muted px-4 py-2.5 text-sm text-foreground placeholder-muted-foreground outline-none transition-colors focus:border-primary/50 sm:order-2",
              textInputDisabled && "cursor-not-allowed opacity-50"
            )}
          />

          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={!text.trim() || textInputDisabled}
            onClick={() => setPreviewOpen(true)}
            title="Preview message before sending"
            aria-label="Preview message"
            className="order-1 h-9 w-9 shrink-0 p-0 text-muted-foreground hover:text-foreground disabled:opacity-40 sm:order-3"
          >
            <Eye className="h-4 w-4" />
          </Button>

          {/* Direct WhatsApp-style Microphone button — always visible for 1-click voice recording */}
          <GatedButton
            type="button"
            variant="ghost"
            size="sm"
            canAct={!readOnly}
            gateReason={tGate("reasons.sendMessages")}
            disabled={busy || recording}
            onClick={() => void startRecording()}
            title={
              sessionExpired
                ? "Record voice note (requires active 24h chat)"
                : "Record & send voice note"
            }
            aria-label="Record voice note"
            className={cn(
              "order-1 h-9 w-9 shrink-0 p-0 sm:order-3",
              sessionExpired
                ? "text-muted-foreground/50 hover:text-muted-foreground"
                : "text-muted-foreground hover:bg-primary/10 hover:text-primary",
            )}
          >
            <Mic className="h-4 w-4" />
          </GatedButton>

          <GatedButton
            size="sm"
            canAct={!readOnly}
            gateReason={tGate("reasons.sendMessages")}
            disabled={!text.trim() || textInputDisabled || sending}
            onClick={handleSend}
            className="order-1 h-9 w-9 shrink-0 bg-primary p-0 hover:bg-primary/90 disabled:opacity-40 sm:order-3"
          >
            <Send className="h-4 w-4" />
          </GatedButton>
        </div>
      )}

      {/* Hint + live formatting status sits outside the flex row so its
          height doesn't push `items-end` buttons below the textarea. */}
      {!draft && !recording && (
        <div className="mt-1 flex flex-wrap items-center justify-between gap-2 pl-1 text-[10px] text-muted-foreground sm:pl-[5.5rem]">
          <div className="flex flex-wrap items-center gap-2">
            {!sessionExpired && (
              <button
                type="button"
                onClick={toggleNoReadMore}
                title={
                  noReadMoreMode
                    ? 'No "Read more" mode is ON — long messages and long PDF captions automatically send in crisp <=4-line bubbles so 100% of text is visible without "Read more". Click to turn OFF.'
                    : 'No "Read more" mode is OFF — messages send as one single bubble (WhatsApp may fold >4 lines behind "Read more"). Click to turn ON.'
                }
                className={cn(
                  "inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-medium transition-colors",
                  noReadMoreMode
                    ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-400"
                    : "border-border bg-muted/60 text-muted-foreground hover:text-foreground",
                )}
              >
                <CheckCircle2 className="h-2.5 w-2.5" />
                No &ldquo;Read more&rdquo;: {noReadMoreMode ? "ON" : "OFF"}
              </button>
            )}
            <span>{t("draftHint")}</span>
          </div>
          {text.trim().length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              {!sessionExpired && formattingAnalysis.urls.length > 0 && (
                <button
                  type="button"
                  onClick={() => setPreviewUrl((prev) => !prev)}
                  title={
                    previewUrl
                      ? "Link preview card is ON (WhatsApp will preview only the first link and may fold earlier). Click to turn OFF."
                      : "Link preview card is OFF so multiple links display cleanly without a large preview card. Click to turn ON."
                  }
                  className={cn(
                    "inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] transition-colors",
                    previewUrl
                      ? "border-amber-500/40 bg-amber-500/10 text-amber-300"
                      : "border-border bg-muted/60 text-muted-foreground hover:text-foreground",
                  )}
                >
                  <Link2 className="h-2.5 w-2.5" />
                  Link preview: {previewUrl ? "On" : "Off"}
                </button>
              )}
              {needsFormattingFix && (
                <button
                  type="button"
                  onClick={handleOptimizeSpacing}
                  className="inline-flex items-center gap-1 text-primary hover:underline"
                >
                  <Wand2 className="h-3 w-3" />
                  {formattingAnalysis.hasMarkdownLinks
                    ? "Fix Markdown links & spacing"
                    : "Fix spacing"}
                </button>
              )}
              {!sessionExpired && noReadMoreMode ? (
                <span className="inline-flex items-center gap-1 text-emerald-400">
                  <CheckCircle2 className="h-3 w-3" />
                  {formattingAnalysis.charCount} chars ·{" "}
                  {splitForNoReadMore(text).length === 1
                    ? "1 clean bubble (no Read more)"
                    : `${splitForNoReadMore(text).length} clean bubbles (no Read more)`}
                </span>
              ) : (
                <span
                  className={cn(
                    "inline-flex items-center gap-1",
                    formattingAnalysis.likelyTruncated ||
                      formattingAnalysis.hasMarkdownLinks ||
                      formattingAnalysis.multiLinkPreviewRisk
                      ? "text-amber-400"
                      : "text-muted-foreground",
                  )}
                >
                  {(formattingAnalysis.likelyTruncated ||
                    formattingAnalysis.hasMarkdownLinks ||
                    formattingAnalysis.multiLinkPreviewRisk) && (
                    <AlertTriangle className="h-3 w-3" />
                  )}
                  {formattingAnalysis.charCount} chars · ~
                  {formattingAnalysis.estimatedMobileLines} lines
                  {formattingAnalysis.likelyTruncated
                    ? ` · May fold after ~${formattingAnalysis.foldLineLimit} lines`
                    : ""}
                </span>
              )}
            </div>
          )}
        </div>
      )}

      {/* Interactive-message builder dialog. */}
      <Dialog open={interactiveOpen} onOpenChange={setInteractiveOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t("interactiveMessage")}</DialogTitle>
          </DialogHeader>
          <div className="max-h-[70vh] overflow-y-auto">
            <InteractiveBuilder
              value={interactivePayload}
              onChange={setInteractivePayload}
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={savingQuickReply}
              onClick={saveAsQuickReply}
            >
              {savingQuickReply ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              ) : (
                <Zap className="mr-1 h-4 w-4" />
              )}
              {t("saveAsQuickReply")}
            </Button>
            <Button onClick={sendInteractive}>
              <Send className="mr-1 h-4 w-4" />
              {t("send")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Quick-reply picker. */}
      <QuickReplyPicker
        open={quickReplyOpen}
        onOpenChange={setQuickReplyOpen}
        onPick={handlePickQuickReply}
      />

      {/* Outgoing WhatsApp Message Preview Dialog */}
      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent className="border-border bg-popover sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-popover-foreground">
              <Eye className="h-4 w-4 text-primary" />
              WhatsApp Message Preview
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="max-h-[45vh] space-y-2 overflow-y-auto rounded-xl bg-background bg-[url('/inbox-doodle.svg')] p-4">
              {!sessionExpired && noReadMoreMode ? (
                splitForNoReadMore(text).map((bubble, idx, all) => (
                  <div
                    key={idx}
                    className="ml-auto max-w-[90%] rounded-2xl rounded-br-md bg-primary px-3.5 py-2 text-sm text-primary-foreground shadow-sm"
                  >
                    <p className="whitespace-pre-wrap break-words">{bubble}</p>
                    {all.length > 1 && (
                      <p className="mt-1 text-right text-[10px] text-primary-foreground/75">
                        Part {idx + 1}/{all.length} · Full text visible
                      </p>
                    )}
                  </div>
                ))
              ) : (
                <div className="ml-auto max-w-[90%] rounded-2xl rounded-br-md bg-primary px-3.5 py-2.5 text-sm text-primary-foreground shadow-sm">
                  <p className="whitespace-pre-wrap break-words">
                    {text.trim()}
                  </p>
                  {formattingAnalysis.likelyTruncated && (
                    <p className="mt-1.5 border-t border-primary-foreground/20 pt-1 text-[11px] font-medium text-primary-foreground/85">
                      … WhatsApp may show &ldquo;Read more&rdquo; around ~
                      {formattingAnalysis.foldLineLimit} mobile lines
                    </p>
                  )}
                </div>
              )}
            </div>

            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>
                {formattingAnalysis.charCount} chars · ~
                {formattingAnalysis.estimatedMobileLines} mobile line
                {formattingAnalysis.estimatedMobileLines === 1 ? "" : "s"}
              </span>
              {!sessionExpired && noReadMoreMode ? (
                <span className="inline-flex items-center gap-1 text-emerald-400">
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  Zero &ldquo;Read more&rdquo; ({splitForNoReadMore(text).length} bubble
                  {splitForNoReadMore(text).length === 1 ? "" : "s"})
                </span>
              ) : formattingAnalysis.likelyTruncated ? (
                <span className="inline-flex items-center gap-1 text-amber-400">
                  <AlertTriangle className="h-3.5 w-3.5" />
                  May collapse on mobile
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 text-emerald-400">
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  Clean preview fit
                </span>
              )}
            </div>

            {(!noReadMoreMode || sessionExpired) && formattingAnalysis.tips.length > 0 && (
              <div className="space-y-1 rounded-lg border border-amber-500/30 bg-amber-500/10 p-2.5 text-xs text-amber-300">
                {formattingAnalysis.tips.map((tip, idx) => (
                  <p key={idx}>• {tip}</p>
                ))}
              </div>
            )}

            <p className="text-[11px] text-muted-foreground">
              {!sessionExpired && noReadMoreMode
                ? 'No "Read more" mode sends each part in <=4 mobile lines with link previews disabled so your customer sees every word immediately.'
                : 'WhatsApp controls native "Read more" folding on messages over ~4–5 lines. Enable No "Read more" mode to show 100% of text without folding.'}
            </p>
          </div>
          <DialogFooter className="gap-2">
            {needsFormattingFix && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleOptimizeSpacing}
                className="mr-auto border-border text-xs"
              >
                <Wand2 className="mr-1 h-3.5 w-3.5" />
                Fix Formatting
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              onClick={() => setPreviewOpen(false)}
              className="border-border"
            >
              Edit
            </Button>
            <Button
              type="button"
              disabled={!text.trim() || sending || textInputDisabled}
              onClick={() => void handleSend()}
              className="bg-primary text-primary-foreground hover:bg-primary/90"
            >
              <Send className="mr-1.5 h-3.5 w-3.5" />
              {t("send")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * Staged-attachment preview with caption + send/discard. Declared at
 * module scope (not nested in MessageComposer) so React keeps it mounted
 * across the parent's re-renders — a nested component would remount the
 * caption input on every keystroke and drop focus.
 */
function MediaDraftPreview({
  draft,
  busy,
  readOnly,
  noReadMoreMode,
  onCaptionChange,
  onDiscard,
  onSend,
  t,
}: {
  draft: MediaDraft;
  busy: boolean;
  readOnly: boolean;
  noReadMoreMode: boolean;
  onCaptionChange: (caption: string) => void;
  onDiscard: () => void;
  onSend: () => void;
  t: ReturnType<typeof useTranslations>;
}) {
  const tGate = useTranslations("GatedButton");
  const captionAnalysis =
    draft.kind !== "audio" && draft.caption.trim().length > 0
      ? analyzeOutgoingMessage(draft.caption, { context: "media_caption" })
      : null;
  const willSeparateCaption = Boolean(
    noReadMoreMode &&
      draft.kind !== "audio" &&
      draft.caption.trim().length > 0 &&
      (estimateMobileLines(draft.caption.trim()) > 2 ||
        draft.caption.trim().length > 85),
  );
  return (
    <div className="rounded-xl border border-border bg-muted/40 p-3">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          {draft.kind === "image" && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={draft.mediaUrl}
              alt={draft.filename}
              className="max-h-40 rounded-lg object-cover"
            />
          )}
          {draft.kind === "video" && (
            <video src={draft.mediaUrl} controls className="max-h-40 rounded-lg" />
          )}
          {draft.kind === "audio" && (
            <div className="space-y-1.5">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <FileAudio className="h-4 w-4 shrink-0 text-primary" />
                <span className="truncate">{draft.filename}</span>
              </div>
              <audio src={draft.mediaUrl} controls className="w-full" />
            </div>
          )}
          {draft.kind === "document" && (
            <div className="flex items-center gap-2 text-sm text-foreground">
              <FileText className="h-5 w-5 shrink-0 text-muted-foreground" />
              <span className="truncate">{draft.filename}</span>
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={onDiscard}
          aria-label={t("removeAttachment")}
          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="mt-2 flex items-end gap-2">
        {draft.kind !== "audio" && (
          <input
            value={draft.caption}
            maxLength={MEDIA_CAPTION_MAX}
            onChange={(e) => onCaptionChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                onSend();
              }
            }}
            placeholder={t("addCaption")}
            className="flex-1 rounded-xl border border-border bg-muted px-4 py-2.5 text-sm text-foreground placeholder-muted-foreground outline-none transition-colors focus:border-primary/50"
          />
        )}
        <GatedButton
          size="sm"
          canAct={!readOnly}
          gateReason={tGate("reasons.sendMessages")}
          disabled={busy}
          onClick={onSend}
          className={cn(
            "h-9 w-9 shrink-0 bg-primary p-0 hover:bg-primary/90 disabled:opacity-40",
            draft.kind === "audio" && "ml-auto",
          )}
        >
          <Send className="h-4 w-4" />
        </GatedButton>
      </div>
      {willSeparateCaption ? (
        <div className="mt-2 flex items-center gap-1.5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1.5 text-[11px] text-emerald-400">
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
          <span>
            No &ldquo;Read more&rdquo; mode: attachment will send cleanly first,
            followed immediately by your full message in short visible bubbles.
          </span>
        </div>
      ) : captionAnalysis &&
        (captionAnalysis.likelyTruncated || captionAnalysis.hasMarkdownLinks) ? (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-[11px] text-amber-300">
          <span className="flex items-center gap-1.5">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            {captionAnalysis.hasMarkdownLinks
              ? 'Markdown [text](url) links render literally in WhatsApp.'
              : 'WhatsApp folds document/media captions after ~3 lines — keep captions short or enable No "Read more" mode.'}
          </span>
          {captionAnalysis.hasMarkdownLinks && (
            <button
              type="button"
              onClick={() =>
                onCaptionChange(
                  optimizeMessageSpacing(draft.caption, { compactGreeting: true }),
                )
              }
              className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
            >
              <Wand2 className="h-3 w-3" />
              Fix links
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
}
