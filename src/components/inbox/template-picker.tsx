"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { Contact, MessageTemplate } from "@/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import {
  ArrowLeft,
  ChevronRight,
  LayoutTemplate,
  Loader2,
  FileText,
  Image as ImageIcon,
  Video,
  Upload,
  RefreshCw,
  CheckCircle2,
  Search,
  AlertTriangle,
} from "lucide-react";
import {
  extractTemplateVariables,
  extractVariableIndices,
} from "@/lib/whatsapp/template-validators";
import {
  MEDIA_HEADER_SPECS,
  isMediaHeaderKind,
  type MediaHeaderKind,
} from "@/lib/whatsapp/media-header-types";
import {
  uploadAccountMedia,
  MEDIA_MAX_BYTES_BY_KIND,
} from "@/lib/storage/upload-media";
import { analyzeOutgoingMessage } from "@/lib/whatsapp/message-formatting";
import { basenameFromUrl } from "@/lib/media/filename";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

export interface TemplateSendValues {
  body: string[];
  headerText?: string;
  headerMediaUrl?: string;
  headerDocumentFilename?: string;
  buttonParams?: Record<number, string>;
}

interface TemplatePickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (template: MessageTemplate, values: TemplateSendValues) => void;
  /** Optional CRM contact used to quick-fill dynamic variables like customer name. */
  contact?: Contact | null;
}

function renderBodyPreview(body: string, params: string[]): string {
  const keys = extractTemplateVariables(body);
  return body.replace(/\{\{([A-Za-z0-9_]+)\}\}/g, (match, key: string) => {
    const value = params[keys.indexOf(key)];
    return value && value.trim().length > 0 ? value : match;
  });
}

function filenameFromUrl(url: string): string {
  return basenameFromUrl(url) || "Document.pdf";
}

interface UrlButtonSlot {
  index: number;
  text: string;
  url: string;
}

/**
 * Templates may need values for: media headers (PDF/image/video),
 * body variables, a text-header variable, and per-URL-button suffixes.
 */
function collectVariableSlots(template: MessageTemplate): {
  bodyVars: string[];
  headerVar: string | null;
  mediaHeaderKind: MediaHeaderKind | null;
  urlButtonSlots: UrlButtonSlot[];
} {
  // Positional ({{1}}) or named ({{customer_name}}) — see
  // extractTemplateVariables. Missing a named variable here means the
  // send goes out with no parameters and Meta rejects it (#132000).
  const bodyVars = extractTemplateVariables(template.body_text);
  const headerVar =
    template.header_type === "text" && template.header_content
      ? (extractTemplateVariables(template.header_content)[0] ?? null)
      : null;
  const mediaHeaderKind =
    template.header_type && isMediaHeaderKind(template.header_type)
      ? template.header_type
      : null;
  const urlButtonSlots: UrlButtonSlot[] = [];
  (template.buttons ?? []).forEach((b, i) => {
    if (b.type === "URL" && extractVariableIndices(b.url).length > 0) {
      urlButtonSlots.push({ index: i, text: b.text, url: b.url });
    }
  });
  return { bodyVars, headerVar, mediaHeaderKind, urlButtonSlots };
}

export function TemplatePicker({
  open,
  onOpenChange,
  onSelect,
  contact,
}: TemplatePickerProps) {
  const t = useTranslations("Inbox.templatePicker");

  const [templates, setTemplates] = useState<MessageTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<MessageTemplate | null>(null);
  const [params, setParams] = useState<string[]>([]);
  const [headerText, setHeaderText] = useState<string>("");
  const [headerMediaUrl, setHeaderMediaUrl] = useState<string>("");
  const [headerDocFilename, setHeaderDocFilename] = useState<string>("");
  const [uploadingMedia, setUploadingMedia] = useState(false);
  const [buttonParams, setButtonParams] = useState<Record<number, string>>({});
  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadTemplates = async (isCancelled?: () => boolean) => {
    setLoading(true);
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      if (!isCancelled?.()) {
        setTemplates([]);
        setLoading(false);
      }
      return;
    }

    // Scope by RLS (message_templates_select → is_account_member).
    const { data, error } = await supabase
      .from("message_templates")
      .select("*")
      .eq("status", "APPROVED")
      .order("created_at", { ascending: false });

    if (isCancelled?.()) return;
    if (error) {
      console.error("Failed to fetch templates:", error);
      setTemplates([]);
    } else {
      setTemplates((data as MessageTemplate[]) ?? []);
    }
    setLoading(false);
  };

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void loadTemplates(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [open]);

  async function handleSyncTemplates() {
    if (syncing) return;
    setSyncing(true);
    try {
      const res = await fetch("/api/whatsapp/templates/sync", {
        method: "POST",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data?.error || "Failed to sync templates from Meta");
        return;
      }
      toast.success(
        `Synced ${data.total ?? 0} templates from Meta without duplicates`,
      );
      await loadTemplates();
    } catch {
      toast.error("Failed to sync templates from Meta");
    } finally {
      setSyncing(false);
    }
  }

  function resetSelection() {
    setSelected(null);
    setParams([]);
    setHeaderText("");
    setHeaderMediaUrl("");
    setHeaderDocFilename("");
    setButtonParams({});
  }

  function handleOpenChange(next: boolean) {
    if (!next) {
      resetSelection();
      setSearch("");
    }
    onOpenChange(next);
  }

  function pickTemplate(template: MessageTemplate) {
    const slots = collectVariableSlots(template);
    setSelected(template);

    // Pre-fill {{1}} with the contact's name when available so sending to
    // an individual customer takes one click, while staying editable.
    const initialBody = new Array(slots.bodyVars.length).fill("");
    if (initialBody.length > 0 && contact?.name?.trim()) {
      initialBody[0] = contact.name.trim();
    }
    setParams(initialBody);
    setHeaderText("");
    const existingUrl = template.header_media_url ?? "";
    setHeaderMediaUrl(existingUrl);
    setHeaderDocFilename(
      template.header_type === "document" && existingUrl
        ? filenameFromUrl(existingUrl)
        : "",
    );
    setButtonParams({});
  }

  async function handleUploadHeaderFile(file: File, kind: MediaHeaderKind) {
    if (!MEDIA_HEADER_SPECS[kind].mimeTypes.includes(file.type)) {
      toast.error(
        kind === "document"
          ? "Please upload a PDF document."
          : `Unsupported file type for ${kind} header.`,
      );
      return;
    }
    const maxBytes = MEDIA_MAX_BYTES_BY_KIND[kind];
    if (file.size > maxBytes) {
      toast.error(
        `File is ${(file.size / 1024 / 1024).toFixed(1)} MB — max upload size is ${Math.round(maxBytes / 1024 / 1024)} MB.`,
      );
      return;
    }

    setUploadingMedia(true);
    try {
      const { publicUrl } = await uploadAccountMedia("chat-media", file);
      setHeaderMediaUrl(publicUrl);
      if (kind === "document") {
        setHeaderDocFilename(file.name);
      }
      toast.success(`Attached ${file.name}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploadingMedia(false);
    }
  }

  function confirm() {
    if (!selected) return;
    const values: TemplateSendValues = { body: params };
    if (headerText.trim()) values.headerText = headerText.trim();
    if (headerMediaUrl.trim()) {
      values.headerMediaUrl = headerMediaUrl.trim();
      if (selected.header_type === "document") {
        values.headerDocumentFilename =
          headerDocFilename.trim() || filenameFromUrl(headerMediaUrl.trim());
      }
    }
    if (Object.keys(buttonParams).length > 0) {
      values.buttonParams = Object.fromEntries(
        Object.entries(buttonParams).map(([k, v]) => [Number(k), v.trim()]),
      );
    }
    onSelect(selected, values);
    handleOpenChange(false);
  }

  const slots = useMemo(
    () => (selected ? collectVariableSlots(selected) : null),
    [selected],
  );

  const filteredTemplates = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return templates;
    return templates.filter(
      (tpl) =>
        tpl.name.toLowerCase().includes(q) ||
        tpl.body_text.toLowerCase().includes(q) ||
        (tpl.header_type ?? "").toLowerCase().includes(q) ||
        tpl.category.toLowerCase().includes(q),
    );
  }, [templates, search]);

  const renderedPreview = useMemo(
    () => (selected ? renderBodyPreview(selected.body_text, params) : ""),
    [selected, params],
  );

  const previewAnalysis = useMemo(
    () =>
      analyzeOutgoingMessage(renderedPreview, {
        context:
          selected?.category === "Marketing"
            ? "marketing_template"
            : "utility_template",
        hasMediaHeader: Boolean(slots?.mediaHeaderKind),
      }),
    [renderedPreview, selected?.category, slots?.mediaHeaderKind],
  );

  const contactQuickFills = useMemo(() => {
    if (!contact) return [];
    const items: { label: string; value: string }[] = [];
    if (contact.name?.trim()) items.push({ label: "Name", value: contact.name.trim() });
    if (contact.company?.trim())
      items.push({ label: "Company", value: contact.company.trim() });
    if (contact.phone?.trim())
      items.push({ label: "Phone", value: contact.phone.trim() });
    if (contact.email?.trim())
      items.push({ label: "Email", value: contact.email.trim() });
    return items;
  }, [contact]);

  const mediaHeaderSatisfied =
    !slots?.mediaHeaderKind || headerMediaUrl.trim().length > 0;

  const canConfirm =
    !!selected &&
    !!slots &&
    !uploadingMedia &&
    mediaHeaderSatisfied &&
    slots.bodyVars.every((_, i) => (params[i] ?? "").trim().length > 0) &&
    (slots.headerVar === null || headerText.trim().length > 0) &&
    slots.urlButtonSlots.every(
      (s) => (buttonParams[s.index] ?? "").trim().length > 0,
    );

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="border-border bg-popover sm:max-w-lg max-h-[88vh] flex flex-col">
        <DialogHeader>
          <div className="flex items-center justify-between gap-2 pr-6">
            <DialogTitle className="flex items-center gap-2 text-popover-foreground">
              <LayoutTemplate className="h-4 w-4 text-primary" />
              {selected ? selected.name : t("sendTemplate")}
            </DialogTitle>
            {!selected && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void handleSyncTemplates()}
                disabled={syncing}
                className="h-7 gap-1 border-border px-2 text-xs text-muted-foreground hover:text-foreground"
                title="Fetch latest approved templates from Meta"
              >
                <RefreshCw
                  className={`h-3 w-3 ${syncing ? "animate-spin" : ""}`}
                />
                Sync
              </Button>
            )}
          </div>
          <DialogDescription className="text-muted-foreground">
            {selected ? t("fillPlaceholders") : t("pickTemplate")}
          </DialogDescription>
        </DialogHeader>

        {!selected ? (
          <div className="flex min-h-0 flex-1 flex-col gap-2">
            {templates.length > 0 && (
              <div className="relative">
                <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Filter approved templates (e.g. document, welcome)..."
                  className="h-8 border-border bg-muted pl-8 text-xs text-foreground"
                />
              </div>
            )}

            <div className="max-h-[54vh] space-y-2 overflow-y-auto pr-1">
              {loading ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="h-5 w-5 animate-spin text-primary" />
                </div>
              ) : filteredTemplates.length === 0 ? (
                <div className="rounded-md border border-border bg-background/50 p-6 text-center">
                  <p className="text-sm text-popover-foreground">
                    {t("noApprovedTemplates")}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t("noApprovedTemplatesHint")}
                  </p>
                </div>
              ) : (
                filteredTemplates.map((tpl) => (
                  <button
                    key={tpl.id}
                    type="button"
                    onClick={() => pickTemplate(tpl)}
                    className="w-full rounded-md border border-border bg-background/50 p-3 text-left transition-colors hover:border-primary/40 hover:bg-popover"
                  >
                    <div className="flex items-start gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <p className="truncate text-sm font-medium text-popover-foreground">
                            {tpl.name}
                          </p>
                          <Badge className="border border-emerald-500/30 bg-emerald-500/15 text-[10px] text-emerald-400">
                            APPROVED
                          </Badge>
                          <Badge className="border border-primary/30 bg-primary/20 text-[10px] text-primary">
                            {tpl.category}
                          </Badge>
                          {tpl.header_type === "document" && (
                            <Badge className="inline-flex items-center gap-1 border border-blue-500/30 bg-blue-500/15 text-[10px] text-blue-400">
                              <FileText className="h-2.5 w-2.5" />
                              PDF / Doc
                            </Badge>
                          )}
                          {tpl.header_type === "image" && (
                            <Badge className="inline-flex items-center gap-1 border border-border bg-muted text-[10px] text-muted-foreground">
                              <ImageIcon className="h-2.5 w-2.5" />
                              Image
                            </Badge>
                          )}
                          {tpl.header_type === "video" && (
                            <Badge className="inline-flex items-center gap-1 border border-border bg-muted text-[10px] text-muted-foreground">
                              <Video className="h-2.5 w-2.5" />
                              Video
                            </Badge>
                          )}
                          {tpl.language && (
                            <span className="text-[10px] uppercase text-muted-foreground">
                              {tpl.language}
                            </span>
                          )}
                        </div>
                        <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                          {tpl.body_text}
                        </p>
                      </div>
                      <ChevronRight className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
                    </div>
                  </button>
                ))
              )}
            </div>
          </div>
        ) : (
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
            {/* Live WhatsApp-style Preview */}
            <div className="rounded-lg border border-border bg-background/60 p-3">
              <div className="mb-1.5 flex items-center justify-between text-[11px] text-muted-foreground">
                <span>{t("preview")}</span>
                <span>{previewAnalysis.charCount} chars</span>
              </div>

              {selected.header_type === "document" && (
                <div className="mb-2 flex items-center gap-2 rounded-md border border-border bg-muted/70 px-2.5 py-2 text-xs">
                  <FileText className="h-4 w-4 shrink-0 text-primary" />
                  <span className="truncate font-medium text-foreground">
                    {headerDocFilename ||
                      (headerMediaUrl
                        ? filenameFromUrl(headerMediaUrl)
                        : "Attach a PDF document below")}
                  </span>
                  {headerMediaUrl && (
                    <CheckCircle2 className="ml-auto h-3.5 w-3.5 shrink-0 text-emerald-400" />
                  )}
                </div>
              )}

              {selected.header_type === "text" && selected.header_content && (
                <p className="mb-1 text-sm font-semibold text-popover-foreground">
                  {selected.header_content.replace(
                    /\{\{1\}\}/g,
                    headerText.trim() || "{{1}}",
                  )}
                </p>
              )}

              <p className="whitespace-pre-wrap text-sm text-popover-foreground">
                {renderedPreview}
              </p>

              {selected.footer_text && (
                <p className="mt-2 text-xs italic text-muted-foreground">
                  {selected.footer_text}
                </p>
              )}

              {selected.buttons && selected.buttons.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5 border-t border-border/60 pt-2">
                  {selected.buttons.map((b, idx) => (
                    <span
                      key={idx}
                      className="inline-flex items-center rounded border border-primary/30 bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary"
                    >
                      {b.text}
                    </span>
                  ))}
                </div>
              )}

              {previewAnalysis.tips.length > 0 && (
                <div className="mt-2 space-y-1 rounded bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-400">
                  {previewAnalysis.tips.map((tip, idx) => (
                    <div key={idx} className="flex items-start gap-1.5">
                      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      <span>{tip}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
            {/* Media / PDF Document Header Attachment */}
            {slots?.mediaHeaderKind && (
              <div className="space-y-2 rounded-md border border-border bg-muted/30 p-3">
                <div className="flex items-center justify-between gap-2">
                  <Label className="text-xs font-medium text-popover-foreground">
                    {slots.mediaHeaderKind === "document"
                      ? "PDF Document Header Attachment"
                      : `Header ${slots.mediaHeaderKind} attachment`}
                  </Label>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept={MEDIA_HEADER_SPECS[slots.mediaHeaderKind].mimeTypes.join(
                      ",",
                    )}
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file && slots.mediaHeaderKind) {
                        void handleUploadHeaderFile(file, slots.mediaHeaderKind);
                      }
                      e.target.value = "";
                    }}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={uploadingMedia}
                    onClick={() => fileInputRef.current?.click()}
                    className="h-7 gap-1.5 border-border text-xs"
                  >
                    {uploadingMedia ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Upload className="h-3.5 w-3.5" />
                    )}
                    {slots.mediaHeaderKind === "document"
                      ? "Upload PDF"
                      : `Upload ${slots.mediaHeaderKind}`}
                  </Button>
                </div>

                {slots.mediaHeaderKind === "document" && (
                  <Input
                    value={headerDocFilename}
                    onChange={(e) => setHeaderDocFilename(e.target.value)}
                    placeholder="Document filename shown in WhatsApp (e.g. Proposal.pdf)"
                    className="h-8 border-border bg-muted text-xs text-foreground placeholder:text-muted-foreground"
                  />
                )}

                <Input
                  value={headerMediaUrl}
                  onChange={(e) => {
                    const nextUrl = e.target.value;
                    setHeaderMediaUrl(nextUrl);
                    if (
                      slots.mediaHeaderKind === "document" &&
                      !headerDocFilename &&
                      nextUrl
                    ) {
                      setHeaderDocFilename(filenameFromUrl(nextUrl));
                    }
                  }}
                  placeholder={
                    slots.mediaHeaderKind === "document"
                      ? "Or paste public HTTPS PDF URL..."
                      : "Public HTTPS media URL..."
                  }
                  className="h-8 border-border bg-muted text-xs text-foreground placeholder:text-muted-foreground"
                />
                <p className="text-[11px] text-muted-foreground">
                  {slots.mediaHeaderKind === "document"
                    ? "Sent as a native WhatsApp PDF document header (compliant outside the 24-hour window)."
                    : "Sent as the template media header."}
                </p>
              </div>
            )}

            {slots?.headerVar && (
              <div className="space-y-1">
                <Label className="text-xs text-popover-foreground">
                  {t("headerVarLabel", { var: `{{${slots.headerVar}}}` })}
                </Label>
                <Input
                  value={headerText}
                  onChange={(e) => setHeaderText(e.target.value)}
                  placeholder={t("headerValuePlaceholder")}
                  className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
                />
              </div>
            )}

            {slots?.bodyVars.map((v, i) => (
              <div key={v} className="space-y-1">
                <div className="flex flex-wrap items-center justify-between gap-1">
                  <Label className="text-xs text-popover-foreground">
                    {t("bodyVarLabel", { var: `{{${v}}}` })}
                  </Label>
                  {contactQuickFills.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {contactQuickFills.map((qf) => (
                        <button
                          key={qf.label}
                          type="button"
                          onClick={() => {
                            const next = [...params];
                            next[i] = qf.value;
                            setParams(next);
                          }}
                          className="rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground hover:border-primary/40 hover:text-foreground"
                        >
                          {qf.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <Input
                  value={params[i] ?? ""}
                  onChange={(e) => {
                    const next = [...params];
                    next[i] = e.target.value;
                    setParams(next);
                  }}
                  placeholder={t("bodyValuePlaceholder", { val: `{{${v}}}` })}
                  className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
                />
              </div>
            ))}

            {slots?.urlButtonSlots.map((slot) => (
              <div key={slot.index} className="space-y-1">
                <Label className="text-xs text-popover-foreground">
                  {t("urlButtonVarLabel", { text: slot.text, var: "{{1}}" })}
                </Label>
                <Input
                  value={buttonParams[slot.index] ?? ""}
                  onChange={(e) =>
                    setButtonParams((prev) => ({
                      ...prev,
                      [slot.index]: e.target.value,
                    }))
                  }
                  placeholder={t("urlSuffixValuePlaceholder")}
                  className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
                />
                <p className="break-all text-[10px] text-muted-foreground">
                  {t("finalUrl", {
                    url: slot.url.replace(
                      /\{\{1\}\}/g,
                      buttonParams[slot.index] || "{{1}}",
                    ),
                  })}
                </p>
              </div>
            ))}
          </div>
        )}

        <DialogFooter className="gap-2">
          {selected ? (
            <>
              <Button
                variant="outline"
                onClick={resetSelection}
                className="border-border text-popover-foreground hover:bg-muted"
              >
                <ArrowLeft className="h-4 w-4" />
                {t("back")}
              </Button>
              <Button
                disabled={!canConfirm}
                onClick={confirm}
                className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                {t("send")}
              </Button>
            </>
          ) : (
            <Button
              variant="outline"
              onClick={() => handleOpenChange(false)}
              className="border-border text-popover-foreground hover:bg-muted"
            >
              {t("cancel")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
