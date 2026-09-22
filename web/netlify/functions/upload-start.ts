import type { Config } from "@netlify/functions";
import { Client, HttpError, handler, project, readJson } from "../lib/shotgrid";

const NEW_VERSION_STATUS = "rev";   // Pending Review

interface Body {
  sequenceId?: number;
  code?: string;
  filename?: string;
  path?: string;
  playlistId?: number;
  multipart?: boolean;
}

/**
 * Create the Version, then ask ShotGrid where its media should go. The
 * browser sends the file straight to that address - media never passes
 * through Netlify, whose functions cap requests at 6 MB.
 */
export default handler(async (req) => {
  const b = await readJson<Body>(req);
  if (!Number.isInteger(b.sequenceId) || !b.code || !b.filename || !Number.isInteger(b.playlistId)) {
    throw new HttpError(400, "Expected sequenceId, code, filename and playlistId");
  }
  const client = Client.from(req);

  const version = await client.create("Version", {
    project: project(),
    code: b.code,
    entity: { type: "Sequence", id: b.sequenceId },
    description: `Uploaded from ${b.filename}`,
    sg_status_list: NEW_VERSION_STATUS,
    sg_path_to_movie: b.path || b.filename,
    user: { type: "HumanUser", id: client.user.id },
    playlists: [{ type: "Playlist", id: b.playlistId }],
  });

  const query = new URLSearchParams({ filename: b.filename });
  if (b.multipart) query.set("multipart_upload", "true");
  const target = await client.request<UploadTarget>(
    `/api/v1/entity/Version/${version.id}/sg_uploaded_movie/_upload?${query}`);

  return client.json({
    versionId: version.id,
    info: target.data,
    upload: target.links.upload,
    next: target.links.get_next_part ?? null,
    complete: target.links.complete_upload,
  });
});

interface UploadTarget {
  data: Record<string, unknown>;
  links: { upload: string; complete_upload: string; get_next_part?: string };
}

export const config: Config = { path: "/api/upload/start", method: "POST" };
