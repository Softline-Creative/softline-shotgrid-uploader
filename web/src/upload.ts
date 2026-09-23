/**
 * Sending one file to ShotGrid. The Version is created and the upload
 * address fetched by a Netlify function; the bytes go from the browser
 * straight to ShotGrid's storage, never through Netlify.
 */
import { api } from "./api";

// Same thresholds as shotgun_api3: files over 500 MB go up in parts.
export const MULTIPART_THRESHOLD = 500 * 1024 * 1024;
export const PART_SIZE = 20_000_000;

export interface UploadJob {
  file: File;
  path: string;
  sequenceId: number;
  code: string;
  playlistIds: number[];
}

function put(url: string, body: Blob, contentType: string,
             onProgress: (sent: number) => void): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("Content-Type", contentType);
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.getResponseHeader("ETag"));
      else reject(new Error(`storage refused the file (${xhr.status}) ${xhr.responseText.slice(0, 200)}`));
    };
    xhr.onerror = () => reject(new Error(
      "couldn't reach ShotGrid's storage - the upload was blocked by the browser "
      + "(network, or the storage not accepting uploads from this site)"));
    xhr.send(body);
  });
}

/** Upload one file; reports progress 0..1. Returns the new Version id. */
export async function uploadFile(job: UploadJob, onProgress: (fraction: number) => void): Promise<number> {
  const { file } = job;
  const multipart = file.size > MULTIPART_THRESHOLD;
  const contentType = file.type || "application/octet-stream";

  const target = await api.uploadStart({
    sequenceId: job.sequenceId, code: job.code, filename: file.name,
    path: job.path, playlistIds: job.playlistIds, multipart,
  });

  const report = (done: number) => onProgress(file.size ? Math.min(done / file.size, 1) : 1);
  let etags: string[] | undefined;

  if (!multipart) {
    await put(target.upload, file, contentType, report);
  } else {
    etags = [];
    let url: string | null = target.upload;
    let next = target.next;
    for (let offset = 0; offset < file.size; offset += PART_SIZE) {
      if (!url) {
        if (!next) throw new Error("ShotGrid didn't provide the next upload part");
        ({ upload: url, next } = await api.uploadPart(next));
      }
      const etag = await put(url, file.slice(offset, offset + PART_SIZE), contentType,
        (sent) => report(offset + sent));
      if (!etag) {
        throw new Error("the storage didn't return an upload receipt (ETag) for a "
          + "large-file part, so the parts can't be joined");
      }
      etags.push(etag);
      url = null;
    }
  }

  await api.uploadComplete({ link: target.complete, info: target.info, etags, filename: file.name });
  onProgress(1);
  return target.versionId;
}
