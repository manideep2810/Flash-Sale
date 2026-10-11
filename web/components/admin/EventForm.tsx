"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type ChangeEvent, type FormEvent, useRef, useState } from "react";
import { EventCover } from "@/components/EventCover";
import { UploadIcon } from "@/components/Icons";
import {
  type AdminEvent,
  adminCreateEvent,
  adminUpdateEvent,
  COVER_TYPES,
  serverNow,
  toFailure,
  uploadCover,
} from "@/lib/api";
import { CURRENCY } from "@/lib/format";

/** What the form holds: every field as the text in its input. */
interface Draft {
  name: string;
  id: string;
  description: string;
  /** In whole currency units, as typed: "3499" or "3499.50". */
  price: string;
  totalStock: string;
  imageUrl: string;
  /** datetime-local values: local time, to the minute. */
  lobbyOpensAt: string;
  saleOpensAt: string;
  admitRatePerSec: string;
  admitTtlSec: string;
}

type Problems = Partial<Record<keyof Draft, string>>;

const SLUG = /^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$/;
const MINUTE = 60_000;

/** Epoch ms -> the value of a datetime-local input, in this browser's time zone. */
function toLocalInput(ms: number): string {
  const local = new Date(ms - new Date(ms).getTimezoneOffset() * MINUTE);
  return local.toISOString().slice(0, 16);
}

/** The value of a datetime-local input -> epoch ms. NaN when it is empty or not a date. */
const fromLocalInput = (value: string): number => new Date(value).getTime();

/** "Aurora Sound Festival 2026!" -> "aurora-sound-festival-2026": the id the server would make. */
function slugify(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
}

function draftOf(event: AdminEvent | null): Draft {
  if (event) {
    return {
      name: event.name,
      id: event.id,
      description: event.description,
      price: (event.price / 100).toFixed(2),
      totalStock: String(event.totalStock),
      imageUrl: event.imageUrl ?? "",
      lobbyOpensAt: toLocalInput(event.lobbyOpensAt),
      saleOpensAt: toLocalInput(event.saleOpensAt),
      admitRatePerSec: String(event.admitRatePerSec),
      admitTtlSec: String(event.admitTtlSec),
    };
  }
  // A new event: the lobby opens now, the sale in ten minutes.
  const now = serverNow();
  return {
    name: "",
    id: "",
    description: "",
    price: "",
    totalStock: "100",
    imageUrl: "",
    lobbyOpensAt: toLocalInput(now),
    saleOpensAt: toLocalInput(now + 10 * MINUTE),
    admitRatePerSec: "50",
    admitTtlSec: "120",
  };
}

const wholeNumber = (value: string): number => (/^\d+$/.test(value.trim()) ? Number(value) : NaN);

/** The same rules the server applies (services/ticket/src/catalogue/routes.ts), in sentences. */
function problemsOf(draft: Draft, creating: boolean): Problems {
  const problems: Problems = {};
  const name = draft.name.trim();
  if (name === "" || name.length > 120) {
    problems.name = "Give the event a name, up to 120 characters.";
  }
  if (creating && draft.id !== "" && !SLUG.test(draft.id)) {
    problems.id = "3 to 48 lowercase letters, digits and dashes; no dash at either end.";
  }
  if (draft.description.trim().length > 2_000) {
    problems.description = "Keep the description under 2,000 characters.";
  }
  const price = Number(draft.price);
  if (draft.price.trim() === "" || !Number.isFinite(price) || price < 0.01 || price > 1_000_000) {
    problems.price = "Enter a price above zero.";
  }
  if (creating) {
    const stock = wholeNumber(draft.totalStock);
    if (!(stock >= 1 && stock <= 1_000_000)) {
      problems.totalStock = "Between 1 and 1,000,000 tickets.";
    }
  }
  if (draft.imageUrl.trim() !== "" && !/^https:\/\/\S+$/.test(draft.imageUrl.trim())) {
    problems.imageUrl = "An image URL starts with https://";
  }
  const lobby = fromLocalInput(draft.lobbyOpensAt);
  const sale = fromLocalInput(draft.saleOpensAt);
  if (Number.isNaN(lobby)) {
    problems.lobbyOpensAt = "Choose when the lobby opens.";
  }
  if (Number.isNaN(sale)) {
    problems.saleOpensAt = "Choose when the sale opens.";
  } else if (sale < lobby) {
    problems.saleOpensAt = "The sale cannot open before the lobby does.";
  }
  const rate = wholeNumber(draft.admitRatePerSec);
  if (!(rate >= 1 && rate <= 10_000)) {
    problems.admitRatePerSec = "Between 1 and 10,000 people a second.";
  }
  const ttl = wholeNumber(draft.admitTtlSec);
  if (!(ttl >= 10 && ttl <= 3_600)) {
    problems.admitTtlSec = "Between 10 and 3,600 seconds.";
  }
  return problems;
}

/** Create an event, or edit one. `event` null is a new one. */
export function EventForm({ event }: { event: AdminEvent | null }) {
  const router = useRouter();
  const creating = event === null;
  const [draft, setDraft] = useState<Draft>(() => draftOf(event));
  const [problems, setProblems] = useState<Problems>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadProblem, setUploadProblem] = useState<string | null>(null);
  /** Until the admin types an id of their own, it follows the name. */
  const idTouched = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);

  function set(field: keyof Draft, value: string) {
    setDraft((current) => {
      const next = { ...current, [field]: value };
      if (field === "name" && creating && !idTouched.current) {
        next.id = slugify(value);
      }
      return next;
    });
    setProblems((current) => ({ ...current, [field]: undefined }));
  }

  /** Both times from now: the lobby in `lobbyInMin`, the sale `saleAfterMin` after that. */
  function schedule(lobbyInMin: number, saleAfterMin: number) {
    const lobby = serverNow() + lobbyInMin * MINUTE;
    setDraft((current) => ({
      ...current,
      lobbyOpensAt: toLocalInput(lobby),
      saleOpensAt: toLocalInput(lobby + saleAfterMin * MINUTE),
    }));
    setProblems((current) => ({ ...current, lobbyOpensAt: undefined, saleOpensAt: undefined }));
  }

  async function upload(change: ChangeEvent<HTMLInputElement>) {
    const file = change.target.files?.[0];
    // So that choosing the same file again fires a change.
    change.target.value = "";
    if (!file) {
      return;
    }
    setUploading(true);
    setUploadProblem(null);
    try {
      set("imageUrl", await uploadCover(file));
    } catch (error) {
      setUploadProblem(toFailure(error).message);
    } finally {
      setUploading(false);
    }
  }

  async function submit(submitted: FormEvent) {
    submitted.preventDefault();
    if (busy) {
      return;
    }
    const found = problemsOf(draft, creating);
    setProblems(found);
    setFailure(null);
    if (Object.keys(found).length > 0) {
      return;
    }

    const fields = {
      name: draft.name.trim(),
      description: draft.description.trim(),
      price: Math.round(Number(draft.price) * 100),
      imageUrl: draft.imageUrl.trim() === "" ? null : draft.imageUrl.trim(),
      lobbyOpensAt: fromLocalInput(draft.lobbyOpensAt),
      saleOpensAt: fromLocalInput(draft.saleOpensAt),
      admitRatePerSec: Number(draft.admitRatePerSec),
      admitTtlSec: Number(draft.admitTtlSec),
    };
    setBusy(true);
    try {
      if (event) {
        await adminUpdateEvent(event.id, fields);
      } else {
        await adminCreateEvent({
          ...fields,
          ...(draft.id === "" ? {} : { id: draft.id }),
          totalStock: Number(draft.totalStock),
        });
      }
      router.push("/admin");
    } catch (error) {
      const failed = toFailure(error);
      if (failed.code === "EVENT_EXISTS") {
        setProblems({ id: failed.message });
      } else if (failed.code === "BAD_REQUEST") {
        // The server names the fields it refused; the sentences here are ours.
        const fieldsRefused = Object.keys((failed.body.issues as object | undefined) ?? {});
        setFailure(
          fieldsRefused.length > 0
            ? `The server did not accept: ${fieldsRefused.join(", ")}. Check those and save again.`
            : failed.message,
        );
      } else if (!failed.unauthenticated) {
        setFailure(failed.message);
      }
    } finally {
      setBusy(false);
    }
  }

  const error = (field: keyof Draft) =>
    problems[field] ? <span className="field__error">{problems[field]}</span> : null;
  const preview = {
    id: draft.id || "new-event",
    name: draft.name || "New event",
    imageUrl: /^https:\/\/\S+$/.test(draft.imageUrl.trim()) ? draft.imageUrl.trim() : null,
  };

  return (
    <form className="event-form" onSubmit={submit} noValidate>
      <fieldset className="event-form__group">
        <legend>The event</legend>
        <label className="field">
          <span className="field__label">Name</span>
          <input
            name="name"
            value={draft.name}
            onChange={(change) => set("name", change.target.value)}
            placeholder="Aurora Sound Festival"
            aria-invalid={problems.name !== undefined}
          />
          {error("name")}
        </label>

        <label className="field">
          <span className="field__label">Event id</span>
          <input
            name="id"
            value={draft.id}
            onChange={(change) => {
              idTouched.current = true;
              set("id", change.target.value);
            }}
            placeholder="aurora-sound-festival"
            readOnly={!creating}
            spellCheck={false}
            autoCapitalize="none"
            aria-invalid={problems.id !== undefined}
          />
          {error("id") ?? (
            <span className="field__hint">
              {creating
                ? "It is in the event's web address and can never be changed."
                : "An event's id never changes."}
            </span>
          )}
        </label>

        <label className="field">
          <span className="field__label">Description</span>
          <textarea
            name="description"
            rows={4}
            value={draft.description}
            onChange={(change) => set("description", change.target.value)}
            placeholder="What it is, where, and why people will want to be there."
            aria-invalid={problems.description !== undefined}
          />
          {error("description")}
        </label>
      </fieldset>

      <fieldset className="event-form__group">
        <legend>Cover image</legend>
        <div className="cover-picker">
          <EventCover event={preview} className="cover--preview" eager />
          <div className="cover-picker__controls">
            <input
              ref={fileInput}
              type="file"
              name="cover"
              accept={COVER_TYPES.join(",")}
              className="visually-hidden"
              onChange={upload}
              tabIndex={-1}
            />
            <button
              type="button"
              className="btn btn--dark"
              onClick={() => fileInput.current?.click()}
              disabled={uploading}
            >
              <UploadIcon size={18} /> {uploading ? "Uploading…" : "Upload an image"}
            </button>
            <p className="field__hint">
              JPEG, PNG, WebP or AVIF, up to 5 MB. Stored on Cloudinary.
            </p>
            {uploadProblem ? (
              <p className="alert" role="alert">
                {uploadProblem}
              </p>
            ) : null}
            <label className="field">
              <span className="field__label">or paste an image URL</span>
              <input
                name="imageUrl"
                type="url"
                value={draft.imageUrl}
                onChange={(change) => set("imageUrl", change.target.value)}
                placeholder="https://…"
                spellCheck={false}
                aria-invalid={problems.imageUrl !== undefined}
              />
              {error("imageUrl")}
            </label>
            {draft.imageUrl !== "" ? (
              <button
                type="button"
                className="btn btn--ghost btn--small"
                onClick={() => set("imageUrl", "")}
              >
                Remove the image
              </button>
            ) : null}
          </div>
        </div>
      </fieldset>

      <fieldset className="event-form__group">
        <legend>Tickets</legend>
        <div className="field-row">
          <label className="field">
            <span className="field__label">Price per ticket ({CURRENCY})</span>
            <input
              name="price"
              inputMode="decimal"
              value={draft.price}
              onChange={(change) => set("price", change.target.value)}
              placeholder="3499.00"
              aria-invalid={problems.price !== undefined}
            />
            {error("price")}
          </label>
          <label className="field">
            <span className="field__label">Tickets on sale</span>
            <input
              name="totalStock"
              inputMode="numeric"
              value={draft.totalStock}
              onChange={(change) => set("totalStock", change.target.value)}
              readOnly={!creating}
              aria-invalid={problems.totalStock !== undefined}
            />
            {error("totalStock") ?? (
              <span className="field__hint">
                {creating
                  ? "Set once: it cannot be changed after the event is created."
                  : "Set when the event was created."}
              </span>
            )}
          </label>
        </div>
      </fieldset>

      <fieldset className="event-form__group">
        <legend>The sale</legend>
        <div className="field-row">
          <label className="field">
            <span className="field__label">Lobby opens</span>
            <input
              name="lobbyOpensAt"
              type="datetime-local"
              value={draft.lobbyOpensAt}
              onChange={(change) => set("lobbyOpensAt", change.target.value)}
              aria-invalid={problems.lobbyOpensAt !== undefined}
            />
            {error("lobbyOpensAt") ?? (
              <span className="field__hint">From here people can join the waiting room.</span>
            )}
          </label>
          <label className="field">
            <span className="field__label">Sale opens</span>
            <input
              name="saleOpensAt"
              type="datetime-local"
              value={draft.saleOpensAt}
              onChange={(change) => set("saleOpensAt", change.target.value)}
              aria-invalid={problems.saleOpensAt !== undefined}
            />
            {error("saleOpensAt") ?? (
              <span className="field__hint">From here the waiting room lets people in to buy.</span>
            )}
          </label>
        </div>
        <fieldset className="chips" aria-label="Quick schedules">
          <button type="button" className="chip" onClick={() => schedule(0, 0)}>
            On sale now
          </button>
          <button type="button" className="chip" onClick={() => schedule(0, 5)}>
            Lobby now, sale in 5 min
          </button>
          <button type="button" className="chip" onClick={() => schedule(45, 15)}>
            Sale in 1 hour
          </button>
          <button type="button" className="chip" onClick={() => schedule(24 * 60 - 15, 15)}>
            Sale tomorrow
          </button>
        </fieldset>

        <div className="field-row">
          <label className="field">
            <span className="field__label">People let in per second</span>
            <input
              name="admitRatePerSec"
              inputMode="numeric"
              value={draft.admitRatePerSec}
              onChange={(change) => set("admitRatePerSec", change.target.value)}
              aria-invalid={problems.admitRatePerSec !== undefined}
            />
            {error("admitRatePerSec") ?? (
              <span className="field__hint">How fast the line moves once the sale is open.</span>
            )}
          </label>
          <label className="field">
            <span className="field__label">Length of a turn (seconds)</span>
            <input
              name="admitTtlSec"
              inputMode="numeric"
              value={draft.admitTtlSec}
              onChange={(change) => set("admitTtlSec", change.target.value)}
              aria-invalid={problems.admitTtlSec !== undefined}
            />
            {error("admitTtlSec") ?? (
              <span className="field__hint">How long someone let in has to reserve.</span>
            )}
          </label>
        </div>
      </fieldset>

      {failure ? (
        <p className="alert" role="alert">
          {failure}
        </p>
      ) : null}
      <div className="event-form__actions">
        <Link className="btn btn--ghost" href="/admin">
          Cancel
        </Link>
        <button type="submit" className="btn btn--primary" disabled={busy || uploading}>
          {busy ? "Saving…" : creating ? "Create event" : "Save changes"}
        </button>
      </div>
    </form>
  );
}
