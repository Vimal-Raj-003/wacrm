"use client";

import { useEffect, useState, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import type { Contact, Conversation } from "@/types";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Search,
  Loader2,
  MessageSquarePlus,
  UserPlus,
  Users,
  ShieldCheck,
  Building2,
  Phone,
} from "lucide-react";
import { toast } from "sonner";
import { contactHandle } from "@/lib/whatsapp/wa-identity";
import { parseInternationalPhone } from "@/lib/whatsapp/phone-utils";

interface NewChatDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConversationOpened: (conversation: Conversation) => void;
}

/**
 * Lets an agent pick ANY existing CRM contact — or create a new one —
 * and jump straight into an individual 1-to-1 WhatsApp chat thread
 * without waiting for the customer to message first.
 */
export function NewChatDialog({
  open,
  onOpenChange,
  onConversationOpened,
}: NewChatDialogProps) {
  const [tab, setTab] = useState<"existing" | "new">("existing");
  const [search, setSearch] = useState("");
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loadingContacts, setLoadingContacts] = useState(false);
  const [openingId, setOpeningId] = useState<string | null>(null);

  // New contact form fields
  const [newName, setNewName] = useState("");
  const [newPhone, setNewPhone] = useState("");
  const [newCompany, setNewCompany] = useState("");
  const [creatingNew, setCreatingNew] = useState(false);

  const fetchContacts = useCallback(async (queryText: string) => {
    setLoadingContacts(true);
    try {
      const supabase = createClient();
      let query = supabase
        .from("contacts")
        .select("*")
        .order("updated_at", { ascending: false })
        .limit(30);

      const q = queryText.trim();
      if (q) {
        const like = `%${q}%`;
        query = query.or(
          `name.ilike.${like},phone.ilike.${like},company.ilike.${like},email.ilike.${like}`,
        );
      }

      const { data, error } = await query;
      if (error) {
        console.error("Failed to search contacts:", error);
        setContacts([]);
        return;
      }
      setContacts((data as Contact[]) ?? []);
    } finally {
      setLoadingContacts(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => {
      void fetchContacts(search);
    }, 180);
    return () => clearTimeout(timer);
  }, [open, search, fetchContacts]);

  function handleOpenChange(next: boolean) {
    if (!next) {
      setSearch("");
      setNewName("");
      setNewPhone("");
      setNewCompany("");
      setTab("existing");
    }
    onOpenChange(next);
  }

  async function openForExisting(contact: Contact) {
    setOpeningId(contact.id);
    try {
      const res = await fetch("/api/whatsapp/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contact_id: contact.id }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.conversation) {
        toast.error(data?.error || "Failed to open WhatsApp chat");
        return;
      }
      onConversationOpened(data.conversation as Conversation);
      handleOpenChange(false);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to open WhatsApp chat",
      );
    } finally {
      setOpeningId(null);
    }
  }

  async function handleCreateAndOpen(e: React.FormEvent) {
    e.preventDefault();
    const phone = newPhone.trim();
    if (!parseInternationalPhone(phone)) {
      toast.error(
        "Enter a valid international phone number starting with + and country code (e.g. +919876543210).",
      );
      return;
    }

    setCreatingNew(true);
    try {
      const res = await fetch("/api/whatsapp/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          phone,
          name: newName.trim() || undefined,
          company: newCompany.trim() || undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.conversation) {
        toast.error(data?.error || "Failed to start conversation");
        return;
      }
      onConversationOpened(data.conversation as Conversation);
      handleOpenChange(false);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to start conversation",
      );
    } finally {
      setCreatingNew(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="border-border bg-popover sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-popover-foreground">
            <MessageSquarePlus className="h-4 w-4 text-primary" />
            New WhatsApp Conversation
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">
            Select an existing CRM contact or add a new phone number to open an
            individual 1-to-1 WhatsApp chat.
          </DialogDescription>
        </DialogHeader>

        <Tabs
          value={tab}
          onValueChange={(v) => setTab(v as "existing" | "new")}
          className="w-full"
        >
          <TabsList className="grid w-full grid-cols-2 bg-muted">
            <TabsTrigger value="existing" className="gap-1.5 text-xs">
              <Users className="h-3.5 w-3.5" />
              Existing Contacts
            </TabsTrigger>
            <TabsTrigger value="new" className="gap-1.5 text-xs">
              <UserPlus className="h-3.5 w-3.5" />
              New Contact
            </TabsTrigger>
          </TabsList>

          <TabsContent value="existing" className="mt-3 space-y-3">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search contacts by name, phone, or company..."
                className="border-border bg-muted pl-9 text-sm text-foreground"
                autoFocus
              />
            </div>

            <div className="max-h-64 space-y-1.5 overflow-y-auto pr-1">
              {loadingContacts ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="h-5 w-5 animate-spin text-primary" />
                </div>
              ) : contacts.length === 0 ? (
                <div className="rounded-md border border-border bg-background/50 p-6 text-center">
                  <p className="text-sm text-muted-foreground">
                    No matching contacts found.
                  </p>
                  <Button
                    type="button"
                    variant="link"
                    size="sm"
                    onClick={() => {
                      if (search.trim().startsWith("+")) {
                        setNewPhone(search.trim());
                      } else if (search.trim()) {
                        setNewName(search.trim());
                      }
                      setTab("new");
                    }}
                    className="mt-1 text-xs"
                  >
                    Create a new contact instead
                  </Button>
                </div>
              ) : (
                contacts.map((c) => {
                  const isOpening = openingId === c.id;
                  const label = c.name || contactHandle(c);
                  return (
                    <button
                      key={c.id}
                      type="button"
                      disabled={openingId !== null}
                      onClick={() => void openForExisting(c)}
                      className="flex w-full items-center gap-3 rounded-lg border border-border bg-background/50 px-3 py-2.5 text-left transition-colors hover:border-primary/40 hover:bg-muted/60 disabled:opacity-60"
                    >
                      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                        {label.charAt(0).toUpperCase()}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-foreground">
                          {c.name || "Unnamed contact"}
                        </p>
                        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                          <span className="inline-flex items-center gap-1 font-mono">
                            <Phone className="h-3 w-3" />
                            {contactHandle(c)}
                          </span>
                          {c.company && (
                            <span className="inline-flex items-center gap-1 truncate">
                              <Building2 className="h-3 w-3" />
                              {c.company}
                            </span>
                          )}
                        </div>
                      </div>
                      {isOpening ? (
                        <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" />
                      ) : (
                        <span className="shrink-0 text-xs font-medium text-primary">
                          Open Chat
                        </span>
                      )}
                    </button>
                  );
                })
              )}
            </div>
          </TabsContent>

          <TabsContent value="new" className="mt-3">
            <form onSubmit={handleCreateAndOpen} className="space-y-3">
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">
                  Phone Number (with country code){" "}
                  <span className="text-red-400">*</span>
                </Label>
                <Input
                  value={newPhone}
                  onChange={(e) => setNewPhone(e.target.value)}
                  placeholder="+919876543210"
                  required
                  className="border-border bg-muted font-mono text-sm text-foreground"
                />
                <p className="text-[11px] text-muted-foreground">
                  Include leading + and country code. Existing numbers are
                  automatically matched without creating duplicates.
                </p>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">
                  Contact Name
                </Label>
                <Input
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="Customer full name"
                  className="border-border bg-muted text-sm text-foreground"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Company</Label>
                <Input
                  value={newCompany}
                  onChange={(e) => setNewCompany(e.target.value)}
                  placeholder="Optional company name"
                  className="border-border bg-muted text-sm text-foreground"
                />
              </div>
              <Button
                type="submit"
                disabled={creatingNew || !newPhone.trim()}
                className="w-full bg-primary text-primary-foreground hover:bg-primary/90"
              >
                {creatingNew ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <MessageSquarePlus className="mr-2 h-4 w-4" />
                )}
                Open WhatsApp Chat
              </Button>
            </form>
          </TabsContent>
        </Tabs>

        <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-[11px] text-muted-foreground">
          <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
          <p>
            <strong className="text-foreground">WhatsApp Policy:</strong> Ensure
            the customer has opted in. Business-initiated first messages (and
            chats outside the 24-hour customer window) must start with an
            approved WhatsApp template.
          </p>
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => handleOpenChange(false)}
            className="border-border text-popover-foreground hover:bg-muted"
          >
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
