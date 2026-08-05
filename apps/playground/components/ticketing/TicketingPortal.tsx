"use client";

import {
  type ChangeEvent,
  type Dispatch,
  type FormEvent,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type { ZodType } from "zod";

import {
  AttachmentPicker,
  type QueuedAttachment,
} from "@/components/ticketing/AttachmentPicker";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  ApiErrorResponseSchema,
  CreateReplyRequestSchema,
  CreateReplyResponseSchema,
  CreateTicketRequestSchema,
  CreateTicketResponseSchema,
  PresignUploadResponseSchema,
  TicketDetailResponseSchema,
  TicketListResponseSchema,
  type PresignUploadResponse,
  type ResolvedAttachmentOptions,
  type TicketCategory,
  type TicketDetail,
  type TicketStatus,
} from "@/lib/ticketing/schemas";

type TicketingPortalProps = {
  sessionToken: string;
  initialView: "list" | "create";
  className?: string;
  attachments: ResolvedAttachmentOptions;
};

const CATEGORY_LABELS: Record<TicketCategory, string> = {
  bug: "Bug",
  request: "Request",
  question: "Question",
};

const STATUS_LABELS: Record<TicketStatus, string> = {
  open: "Open",
  in_progress: "In progress",
  waiting_for_user: "Waiting for you",
  resolved: "Resolved",
  closed: "Closed",
};

class PortalRequestError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PortalRequestError";
  }
}

async function requestJson<T>(
  path: string,
  schema: ZodType<T>,
  sessionToken: string,
  init?: RequestInit,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${sessionToken}`,
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...init?.headers,
      },
      cache: "no-store",
    });
  } catch {
    throw new PortalRequestError("NETWORK_ERROR", "Could not reach the ticketing service");
  }

  const payload: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const parsed = ApiErrorResponseSchema.safeParse(payload);
    throw new PortalRequestError(
      parsed.success ? parsed.data.error.code : "REQUEST_FAILED",
      parsed.success ? parsed.data.error.message : "The ticketing request failed",
    );
  }

  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new PortalRequestError("INVALID_RESPONSE", "The ticketing service returned an invalid response");
  }
  return parsed.data;
}

function uploadDirect(
  upload: PresignUploadResponse,
  file: File,
  onProgress: (progress: number) => void,
) {
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(upload.method, upload.uploadUrl, true);
    xhr.timeout = 60_000;
    for (const [name, value] of Object.entries(upload.headers)) xhr.setRequestHeader(name, value);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error("The storage service rejected the upload"));
    };
    xhr.onerror = () => reject(new Error("The upload was interrupted"));
    xhr.onabort = () => reject(new Error("The upload was cancelled"));
    xhr.ontimeout = () => reject(new Error("The upload timed out"));
    xhr.send(file);
  });
}

function updateAttachment(
  setAttachments: Dispatch<SetStateAction<QueuedAttachment[]>>,
  id: string,
  update: Partial<QueuedAttachment>,
) {
  setAttachments((current) =>
    current.map((attachment) => (attachment.id === id ? { ...attachment, ...update } : attachment)),
  );
}

function disposeAttachments(attachments: QueuedAttachment[]) {
  for (const attachment of attachments) {
    if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
  }
}

function friendlyDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function statusVariant(status: TicketStatus): "default" | "secondary" | "destructive" | "outline" {
  if (status === "open") return "default";
  if (status === "waiting_for_user") return "destructive";
  if (status === "resolved" || status === "closed") return "outline";
  return "secondary";
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Something went wrong";
}

export function TicketingPortal({
  sessionToken,
  initialView,
  className,
  attachments: attachmentOptions,
}: TicketingPortalProps) {
  const [view, setView] = useState(initialView);
  const [sessionExpired, setSessionExpired] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const [selectedTicketId, setSelectedTicketId] = useState<string>();

  const [tickets, setTickets] = useState<Awaited<ReturnType<typeof TicketListResponseSchema.parse>>["items"]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string>();
  const [cursorHistory, setCursorHistory] = useState<string[]>([]);
  const [statusFilter, setStatusFilter] = useState<TicketStatus | "all">("all");
  const [categoryFilter, setCategoryFilter] = useState<TicketCategory | "all">("all");
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string>();
  const [listReload, setListReload] = useState(0);

  const [detail, setDetail] = useState<TicketDetail>();
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string>();
  const [detailReload, setDetailReload] = useState(0);

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState<TicketCategory>("bug");
  const [createAttachments, setCreateAttachments] = useState<QueuedAttachment[]>([]);
  const [createError, setCreateError] = useState<string>();
  const [creating, setCreating] = useState(false);
  const createIdempotencyKey = useRef(crypto.randomUUID());
  const createIdempotencyPayload = useRef<string | undefined>(undefined);

  const [reply, setReply] = useState("");
  const [replyAttachments, setReplyAttachments] = useState<QueuedAttachment[]>([]);
  const [replyError, setReplyError] = useState<string>();
  const [replying, setReplying] = useState(false);
  const replyIdempotencyKey = useRef(crypto.randomUUID());
  const replyIdempotencyPayload = useRef<string | undefined>(undefined);
  const latestCreateAttachments = useRef(createAttachments);
  const latestReplyAttachments = useRef(replyAttachments);

  useEffect(() => {
    latestCreateAttachments.current = createAttachments;
  }, [createAttachments]);

  useEffect(() => {
    latestReplyAttachments.current = replyAttachments;
  }, [replyAttachments]);

  useEffect(
    () => () => {
      disposeAttachments(latestCreateAttachments.current);
      disposeAttachments(latestReplyAttachments.current);
    },
    [],
  );

  const noteSessionError = useCallback((error: unknown) => {
    if (error instanceof PortalRequestError && error.code === "SESSION_EXPIRED") {
      setSessionExpired(true);
    }
  }, []);

  useEffect(() => {
    if (selectedTicketId || view !== "list") return;
    let active = true;
    setListLoading(true);
    setListError(undefined);

    const query = new URLSearchParams({ limit: "20" });
    if (cursor) query.set("cursor", cursor);
    if (statusFilter !== "all") query.set("status", statusFilter);
    if (categoryFilter !== "all") query.set("category", categoryFilter);

    void requestJson(
      `/api/ticketing/tickets?${query.toString()}`,
      TicketListResponseSchema,
      sessionToken,
    )
      .then((result) => {
        if (!active) return;
        setTickets(result.items);
        setNextCursor(result.nextCursor);
      })
      .catch((error) => {
        if (!active) return;
        noteSessionError(error);
        setListError(errorMessage(error));
      })
      .finally(() => {
        if (active) setListLoading(false);
      });

    return () => {
      active = false;
    };
  }, [categoryFilter, cursor, listReload, noteSessionError, selectedTicketId, sessionToken, statusFilter, view]);

  useEffect(() => {
    if (!selectedTicketId) {
      setDetail(undefined);
      return;
    }
    let active = true;
    setDetailLoading(true);
    setDetailError(undefined);

    void requestJson(
      `/api/ticketing/tickets/${encodeURIComponent(selectedTicketId)}`,
      TicketDetailResponseSchema,
      sessionToken,
    )
      .then((result) => {
        if (active) setDetail(result.ticket);
      })
      .catch((error) => {
        if (!active) return;
        noteSessionError(error);
        setDetailError(errorMessage(error));
      })
      .finally(() => {
        if (active) setDetailLoading(false);
      });

    return () => {
      active = false;
    };
  }, [detailReload, noteSessionError, selectedTicketId, sessionToken]);

  const uploadOne = useCallback(
    async (
      attachment: QueuedAttachment,
      setAttachments: Dispatch<SetStateAction<QueuedAttachment[]>>,
    ) => {
      if (attachment.uploadId) return attachment.uploadId;
      updateAttachment(setAttachments, attachment.id, {
        status: "uploading",
        progress: 0,
        error: undefined,
      });

      try {
        const presigned = await requestJson(
          "/api/ticketing/uploads/presign",
          PresignUploadResponseSchema,
          sessionToken,
          {
            method: "POST",
            body: JSON.stringify({
              fileName: attachment.file.name,
              contentType: attachment.file.type,
              size: attachment.file.size,
            }),
          },
        );
        await uploadDirect(presigned, attachment.file, (progress) =>
          updateAttachment(setAttachments, attachment.id, { progress }),
        );
        updateAttachment(setAttachments, attachment.id, {
          status: "uploaded",
          progress: 100,
          uploadId: presigned.uploadId,
        });
        return presigned.uploadId;
      } catch (error) {
        noteSessionError(error);
        updateAttachment(setAttachments, attachment.id, {
          status: "error",
          error: errorMessage(error),
        });
        throw error;
      }
    },
    [noteSessionError, sessionToken],
  );

  const uploadAll = useCallback(
    async (
      queue: QueuedAttachment[],
      setAttachments: Dispatch<SetStateAction<QueuedAttachment[]>>,
    ) => {
      const ids = new Map<string, string>();
      for (const attachment of queue) {
        if (attachment.uploadId) ids.set(attachment.id, attachment.uploadId);
      }

      const pending = queue.filter((attachment) => !attachment.uploadId);
      let index = 0;
      let failures = 0;
      const workers = Array.from({ length: Math.min(3, pending.length) }, async () => {
        while (index < pending.length) {
          const attachment = pending[index++];
          try {
            ids.set(attachment.id, await uploadOne(attachment, setAttachments));
          } catch {
            failures += 1;
          }
        }
      });
      await Promise.all(workers);

      return {
        uploadIds: queue.map((attachment) => ids.get(attachment.id)).filter((id): id is string => Boolean(id)),
        failures,
      };
    },
    [uploadOne],
  );

  async function submitTicket(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setCreateError(undefined);

    const input = CreateTicketRequestSchema.safeParse({ title, description, category, uploadIds: [] });
    if (!input.success) {
      setCreateError(input.error.issues[0]?.message ?? "Please check the ticket details");
      return;
    }

    setCreating(true);
    try {
      const uploaded = await uploadAll(createAttachments, setCreateAttachments);
      if (uploaded.failures > 0) {
        setCreateError("One or more attachments could not be uploaded. Retry them, then submit again.");
        return;
      }

      const requestBody = { ...input.data, uploadIds: uploaded.uploadIds };
      const requestFingerprint = JSON.stringify(requestBody);
      if (
        createIdempotencyPayload.current &&
        createIdempotencyPayload.current !== requestFingerprint
      ) {
        createIdempotencyKey.current = crypto.randomUUID();
      }
      createIdempotencyPayload.current = requestFingerprint;

      const result = await requestJson(
        "/api/ticketing/tickets",
        CreateTicketResponseSchema,
        sessionToken,
        {
          method: "POST",
          headers: { "Idempotency-Key": createIdempotencyKey.current },
          body: requestFingerprint,
        },
      );
      disposeAttachments(createAttachments);
      setCreateAttachments([]);
      setTitle("");
      setDescription("");
      setCategory("bug");
      createIdempotencyKey.current = crypto.randomUUID();
      createIdempotencyPayload.current = undefined;
      setDetail(result.ticket);
      setSelectedTicketId(result.ticket.id);
      setView("list");
      setListReload((value) => value + 1);
      setAnnouncement("Ticket created successfully.");
    } catch (error) {
      noteSessionError(error);
      setCreateError(errorMessage(error));
    } finally {
      setCreating(false);
    }
  }

  async function submitReply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedTicketId) return;
    setReplyError(undefined);

    const input = CreateReplyRequestSchema.safeParse({ message: reply, uploadIds: [] });
    if (!input.success) {
      setReplyError(input.error.issues[0]?.message ?? "Please enter a reply");
      return;
    }

    setReplying(true);
    try {
      const uploaded = await uploadAll(replyAttachments, setReplyAttachments);
      if (uploaded.failures > 0) {
        setReplyError("One or more attachments could not be uploaded. Retry them, then submit again.");
        return;
      }

      const requestBody = { ...input.data, uploadIds: uploaded.uploadIds };
      const requestFingerprint = JSON.stringify(requestBody);
      if (
        replyIdempotencyPayload.current &&
        replyIdempotencyPayload.current !== requestFingerprint
      ) {
        replyIdempotencyKey.current = crypto.randomUUID();
      }
      replyIdempotencyPayload.current = requestFingerprint;

      const result = await requestJson(
        `/api/ticketing/tickets/${encodeURIComponent(selectedTicketId)}/replies`,
        CreateReplyResponseSchema,
        sessionToken,
        {
          method: "POST",
          headers: { "Idempotency-Key": replyIdempotencyKey.current },
          body: requestFingerprint,
        },
      );
      disposeAttachments(replyAttachments);
      setReplyAttachments([]);
      setReply("");
      replyIdempotencyKey.current = crypto.randomUUID();
      replyIdempotencyPayload.current = undefined;
      setDetail((current) =>
        current ? { ...current, replies: [...current.replies, result.reply] } : current,
      );
      setDetailReload((value) => value + 1);
      setListReload((value) => value + 1);
      setAnnouncement("Reply sent successfully.");
    } catch (error) {
      noteSessionError(error);
      setReplyError(errorMessage(error));
    } finally {
      setReplying(false);
    }
  }

  if (sessionExpired) {
    return (
      <Alert variant="destructive" className={className}>
        <AlertTitle>Session expired</AlertTitle>
        <AlertDescription>
          Refresh this page to securely reconnect to the ticketing service.
        </AlertDescription>
      </Alert>
    );
  }

  function closeTicketDetails() {
    disposeAttachments(replyAttachments);
    setReplyAttachments([]);
    setReply("");
    setReplyError(undefined);
    replyIdempotencyKey.current = crypto.randomUUID();
    replyIdempotencyPayload.current = undefined;
    setSelectedTicketId(undefined);
  }

  return (
    <section className={`mx-auto w-full max-w-5xl space-y-6 ${className ?? ""}`} aria-label="Support tickets">
      <p className="sr-only" role="status" aria-live="polite">{announcement}</p>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">Support tickets</h2>
          <p className="text-sm text-muted-foreground">Ask a question, report a problem, or follow up on a request.</p>
        </div>
        <div className="flex gap-2">
          <Button
            type="button"
            disabled={creating || replying}
            variant={view === "list" && !selectedTicketId ? "default" : "outline"}
            onClick={() => {
              if (selectedTicketId) closeTicketDetails();
              setView("list");
            }}
          >
            My tickets
          </Button>
          <Button
            type="button"
            disabled={creating || replying}
            variant={view === "create" ? "default" : "outline"}
            onClick={() => {
              if (selectedTicketId) closeTicketDetails();
              setView("create");
            }}
          >
            New ticket
          </Button>
        </div>
      </div>

      {selectedTicketId ? (
        <TicketDetails
          detail={detail}
          loading={detailLoading}
          error={detailError}
          replying={replying}
          reply={reply}
          setReply={setReply}
          replyError={replyError}
          replyAttachments={replyAttachments}
          setReplyAttachments={setReplyAttachments}
          attachmentOptions={attachmentOptions}
          onBack={closeTicketDetails}
          onRetry={() => setDetailReload((value) => value + 1)}
          onSubmitReply={submitReply}
          onRetryAttachment={(attachment) => {
            void uploadOne(attachment, setReplyAttachments).catch(() => undefined);
          }}
        />
      ) : view === "create" ? (
        <Card>
          <CardHeader>
            <CardTitle>Create a support ticket</CardTitle>
            <CardDescription>Include enough detail for the support team to reproduce or answer your request.</CardDescription>
          </CardHeader>
          <form onSubmit={submitTicket}>
            <CardContent className="space-y-5">
              <div className="space-y-2">
                <label className="text-sm font-medium" htmlFor="ticket-title">Subject</label>
                <Input
                  id="ticket-title"
                  aria-invalid={Boolean(createError)}
                  aria-describedby={createError ? "ticket-create-error" : undefined}
                  value={title}
                  maxLength={160}
                  disabled={creating}
                  onChange={(event: ChangeEvent<HTMLInputElement>) => setTitle(event.target.value)}
                  placeholder="A short summary"
                  required
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium" htmlFor="ticket-category">Category</label>
                <Select value={category} disabled={creating} onValueChange={(value) => {
                  if (value) setCategory(value as TicketCategory);
                }}>
                  <SelectTrigger id="ticket-category"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {Object.entries(CATEGORY_LABELS).map(([value, label]) => (
                      <SelectItem key={value} value={value}>{label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium" htmlFor="ticket-description">Description</label>
                <Textarea
                  id="ticket-description"
                  aria-invalid={Boolean(createError)}
                  aria-describedby={createError ? "ticket-create-error" : undefined}
                  value={description}
                  maxLength={10_000}
                  rows={8}
                  disabled={creating}
                  onChange={(event: ChangeEvent<HTMLTextAreaElement>) => setDescription(event.target.value)}
                  placeholder="What happened, what did you expect, and how can we reproduce it?"
                  required
                />
              </div>
              <AttachmentPicker
                value={createAttachments}
                onChange={setCreateAttachments}
                options={attachmentOptions}
                disabled={creating}
                onRetry={(attachment) => {
                  void uploadOne(attachment, setCreateAttachments).catch(() => undefined);
                }}
              />
              {createError ? (
                <Alert id="ticket-create-error" variant="destructive" role="alert"><AlertDescription>{createError}</AlertDescription></Alert>
              ) : null}
            </CardContent>
            <CardFooter className="justify-end">
              <Button type="submit" disabled={creating}>{creating ? "Submitting…" : "Submit ticket"}</Button>
            </CardFooter>
          </form>
        </Card>
      ) : (
        <TicketList
          tickets={tickets}
          loading={listLoading}
          error={listError}
          statusFilter={statusFilter}
          categoryFilter={categoryFilter}
          hasPrevious={cursorHistory.length > 0}
          hasNext={Boolean(nextCursor)}
          onStatusChange={(value) => {
            setStatusFilter(value);
            setCursor(undefined);
            setCursorHistory([]);
          }}
          onCategoryChange={(value) => {
            setCategoryFilter(value);
            setCursor(undefined);
            setCursorHistory([]);
          }}
          onOpen={setSelectedTicketId}
          onRetry={() => setListReload((value) => value + 1)}
          onPrevious={() => {
            const history = [...cursorHistory];
            const previous = history.pop();
            setCursorHistory(history);
            setCursor(previous || undefined);
          }}
          onNext={() => {
            if (!nextCursor) return;
            setCursorHistory((history) => [...history, cursor ?? ""]);
            setCursor(nextCursor);
          }}
        />
      )}
    </section>
  );
}

type TicketListProps = {
  tickets: Awaited<ReturnType<typeof TicketListResponseSchema.parse>>["items"];
  loading: boolean;
  error?: string;
  statusFilter: TicketStatus | "all";
  categoryFilter: TicketCategory | "all";
  hasPrevious: boolean;
  hasNext: boolean;
  onStatusChange: (value: TicketStatus | "all") => void;
  onCategoryChange: (value: TicketCategory | "all") => void;
  onOpen: (id: string) => void;
  onRetry: () => void;
  onPrevious: () => void;
  onNext: () => void;
};

function TicketList({
  tickets,
  loading,
  error,
  statusFilter,
  categoryFilter,
  hasPrevious,
  hasNext,
  onStatusChange,
  onCategoryChange,
  onOpen,
  onRetry,
  onPrevious,
  onNext,
}: TicketListProps) {
  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="grid gap-4 pt-6 sm:grid-cols-2">
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="ticket-status-filter">Status</label>
            <Select value={statusFilter} onValueChange={(value) => {
              if (value) onStatusChange(value as TicketStatus | "all");
            }}>
              <SelectTrigger id="ticket-status-filter"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                {Object.entries(STATUS_LABELS).map(([value, label]) => (
                  <SelectItem key={value} value={value}>{label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="ticket-category-filter">Category</label>
            <Select value={categoryFilter} onValueChange={(value) => {
              if (value) onCategoryChange(value as TicketCategory | "all");
            }}>
              <SelectTrigger id="ticket-category-filter"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All categories</SelectItem>
                {Object.entries(CATEGORY_LABELS).map(([value, label]) => (
                  <SelectItem key={value} value={value}>{label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {loading ? (
        <div className="space-y-3" role="status" aria-live="polite" aria-label="Loading tickets">
          <span className="sr-only">Loading tickets</span>
          {[0, 1, 2].map((key) => <Skeleton key={key} className="h-28 w-full" />)}
        </div>
      ) : error ? (
        <Alert variant="destructive">
          <AlertTitle>Could not load tickets</AlertTitle>
          <AlertDescription className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
            <span>{error}</span><Button type="button" size="sm" variant="outline" onClick={onRetry}>Retry</Button>
          </AlertDescription>
        </Alert>
      ) : tickets.length === 0 ? (
        <Card><CardContent className="py-12 text-center"><p className="font-medium">No tickets found</p><p className="mt-1 text-sm text-muted-foreground">Try changing the filters or create a new ticket.</p></CardContent></Card>
      ) : (
        <ul className="space-y-3">
          {tickets.map((ticket) => (
            <li key={ticket.id}>
              <Card>
                <CardHeader className="pb-3">
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                    <div><CardTitle className="text-base">{ticket.title}</CardTitle><CardDescription>{friendlyDate(ticket.updatedAt)}</CardDescription></div>
                    <div className="flex flex-wrap gap-2"><Badge variant="outline">{CATEGORY_LABELS[ticket.category]}</Badge><Badge variant={statusVariant(ticket.status)}>{STATUS_LABELS[ticket.status]}</Badge></div>
                  </div>
                </CardHeader>
                <CardFooter className="justify-between pt-0"><span className="text-xs text-muted-foreground">{ticket.replyCount} {ticket.replyCount === 1 ? "reply" : "replies"}</span><Button type="button" size="sm" variant="outline" onClick={() => onOpen(ticket.id)}>View details</Button></CardFooter>
              </Card>
            </li>
          ))}
        </ul>
      )}

      {!loading && !error && (hasPrevious || hasNext) ? (
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" disabled={!hasPrevious} onClick={onPrevious}>Previous</Button>
          <Button type="button" variant="outline" disabled={!hasNext} onClick={onNext}>Next</Button>
        </div>
      ) : null}
    </div>
  );
}

type TicketDetailsProps = {
  detail?: TicketDetail;
  loading: boolean;
  error?: string;
  replying: boolean;
  reply: string;
  setReply: (value: string) => void;
  replyError?: string;
  replyAttachments: QueuedAttachment[];
  setReplyAttachments: Dispatch<SetStateAction<QueuedAttachment[]>>;
  attachmentOptions: ResolvedAttachmentOptions;
  onBack: () => void;
  onRetry: () => void;
  onSubmitReply: (event: FormEvent<HTMLFormElement>) => void;
  onRetryAttachment: (attachment: QueuedAttachment) => void;
};

function TicketDetails({
  detail,
  loading,
  error,
  replying,
  reply,
  setReply,
  replyError,
  replyAttachments,
  setReplyAttachments,
  attachmentOptions,
  onBack,
  onRetry,
  onSubmitReply,
  onRetryAttachment,
}: TicketDetailsProps) {
  if (loading && !detail) return <div role="status" aria-live="polite"><span className="sr-only">Loading ticket details</span><Skeleton className="h-96 w-full" /></div>;
  if (error && !detail) {
    return <Alert variant="destructive"><AlertTitle>Could not load this ticket</AlertTitle><AlertDescription className="flex items-center justify-between gap-3"><span>{error}</span><span className="flex gap-2"><Button type="button" size="sm" variant="outline" onClick={onBack}>Back</Button><Button type="button" size="sm" variant="outline" onClick={onRetry}>Retry</Button></span></AlertDescription></Alert>;
  }
  if (!detail) return null;

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1"><Button className="-ml-3" type="button" variant="ghost" size="sm" disabled={replying} onClick={onBack}>Back to tickets</Button><CardTitle>{detail.title}</CardTitle><CardDescription>Created {friendlyDate(detail.createdAt)}</CardDescription></div>
          <div className="flex flex-wrap gap-2"><Badge variant="outline">{CATEGORY_LABELS[detail.category]}</Badge><Badge variant={statusVariant(detail.status)}>{STATUS_LABELS[detail.status]}</Badge></div>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
        <div><h3 className="text-sm font-semibold">Description</h3><p className="mt-2 whitespace-pre-wrap text-sm leading-6">{detail.description}</p></div>
        {detail.attachments.length > 0 ? (
          <div><h3 className="text-sm font-semibold">Attachments</h3><ul className="mt-2 space-y-1">{detail.attachments.map((attachment) => <li key={attachment.id} className="text-sm"><a className="text-primary underline underline-offset-4" href={attachment.downloadUrl} target="_blank" rel="noreferrer">{attachment.fileName}</a></li>)}</ul></div>
        ) : null}
        <Separator />
        <div>
          <h3 className="text-sm font-semibold">Conversation</h3>
          {detail.replies.length === 0 ? <p className="mt-2 text-sm text-muted-foreground">No replies yet.</p> : (
            <ol className="mt-3 space-y-4">{detail.replies.map((item) => <li key={item.id} className={`rounded-lg border p-4 ${item.author.type === "agent" ? "bg-muted/50" : ""}`}><div className="flex flex-wrap items-center justify-between gap-2"><p className="text-sm font-medium">{item.author.name}{item.author.type === "agent" ? " · Support" : ""}</p><time className="text-xs text-muted-foreground">{friendlyDate(item.createdAt)}</time></div><p className="mt-2 whitespace-pre-wrap text-sm leading-6">{item.message}</p>{item.attachments.length > 0 ? <ul className="mt-3 flex flex-wrap gap-2">{item.attachments.map((attachment) => <li key={attachment.id}><a className="text-xs text-primary underline" href={attachment.downloadUrl} target="_blank" rel="noreferrer">{attachment.fileName}</a></li>)}</ul> : null}</li>)}</ol>
          )}
        </div>
        <Separator />
        <form className="space-y-4" onSubmit={onSubmitReply}>
          <div className="space-y-2"><label className="text-sm font-medium" htmlFor="ticket-reply">Add a reply</label><Textarea id="ticket-reply" rows={5} maxLength={5_000} value={reply} disabled={replying} aria-invalid={Boolean(replyError)} aria-describedby={replyError ? "ticket-reply-error" : undefined} onChange={(event: ChangeEvent<HTMLTextAreaElement>) => setReply(event.target.value)} required /></div>
          <AttachmentPicker value={replyAttachments} onChange={setReplyAttachments} options={attachmentOptions} disabled={replying} onRetry={onRetryAttachment} />
          {replyError ? <Alert id="ticket-reply-error" variant="destructive" role="alert"><AlertDescription>{replyError}</AlertDescription></Alert> : null}
          <div className="flex justify-end"><Button type="submit" disabled={replying}>{replying ? "Sending…" : "Send reply"}</Button></div>
        </form>
      </CardContent>
    </Card>
  );
}
