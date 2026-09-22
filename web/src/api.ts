/** Calls to this site's own Netlify functions. */
import type { EntityLink, Sequence } from "./lib/naming";

export interface User { id: number; name: string; login: string; email: string }

export interface Option extends EntityLink { name: string }

export interface Catalog {
  sequences: Sequence[];
  activations: Option[];
  products: Option[];
  deliverables: Option[];
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** Fired when any call finds the session gone, so the app can show sign-in. */
export const signedOut = new EventTarget();

async function call<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, body === undefined
    ? { credentials: "same-origin" }
    : {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-Requested-With": "uploader" },
        body: JSON.stringify(body),
      });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401) signedOut.dispatchEvent(new Event("signedout"));
    throw new ApiError(res.status, data.error || `${res.status} ${res.statusText}`);
  }
  return data as T;
}

export const api = {
  me: () => call<{ user: User; site: string }>("/api/me"),
  logout: () => call<void>("/api/logout", {}),
  catalog: () => call<Catalog>("/api/catalog"),
  playlist: (date: string) =>
    call<{ id: number; code: string; created: boolean }>("/api/playlist", { date }),
  createSequence: (body: {
    code: string; activationId: number | null; productIds: number[]; deliverableIds: number[];
  }) => call<Sequence>("/api/sequences", body),
  existingVersions: (sequenceIds: number[]) =>
    call<{ versions: { sequenceId: number | null; code: string }[] }>(
      "/api/versions/check", { sequenceIds }),
  uploadStart: (body: {
    sequenceId: number; code: string; filename: string; path: string;
    playlistId: number; multipart: boolean;
  }) => call<{
    versionId: number; info: Record<string, unknown>;
    upload: string; next: string | null; complete: string;
  }>("/api/upload/start", body),
  uploadPart: (link: string) =>
    call<{ upload: string; next: string | null }>("/api/upload/part", { link }),
  uploadComplete: (body: {
    link: string; info: Record<string, unknown>; etags?: string[]; filename: string;
  }) => call<{ ok: true }>("/api/upload/complete", body),
};
