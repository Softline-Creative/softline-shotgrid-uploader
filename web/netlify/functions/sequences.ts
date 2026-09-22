import type { Config } from "@netlify/functions";
import { Client, HttpError, handler, project, readJson } from "../lib/shotgrid";

// Keep in step with catalog.ts and upload_videos.py.
const ACTIVATION_ENTITY = "CustomEntity01";
const PRODUCT_ENTITY = "CustomEntity02";
const DELIVERABLE_ENTITY = "CustomEntity03";

interface Body {
  code?: string;
  activationId?: number | null;
  productIds?: number[];
  deliverableIds?: number[];
}

const ids = (v: unknown): v is number[] => Array.isArray(v) && v.every(Number.isInteger);

/**
 * Create one Sequence, as the desktop app does on Upload. Deliverable is
 * required; Activation and Product are not.
 */
export default handler(async (req) => {
  const b = await readJson<Body>(req);
  const code = b.code?.trim();
  if (!code) throw new HttpError(400, "A new Sequence needs a name");
  if (!ids(b.deliverableIds) || !b.deliverableIds.length) {
    throw new HttpError(400, `"${code}" needs at least one Deliverable`);
  }
  if (b.productIds !== undefined && !ids(b.productIds)) throw new HttpError(400, "Bad productIds");
  if (b.activationId != null && !Number.isInteger(b.activationId)) throw new HttpError(400, "Bad activationId");

  const data: Record<string, unknown> = {
    project: project(),
    code,
    // Activation is a single-entity field; Product and Deliverable are
    // multi, and writing a single link to a multi field fails.
    sg_deliverable: b.deliverableIds.map((id) => ({ type: DELIVERABLE_ENTITY, id })),
  };
  if (b.activationId != null) data.sg_activations = { type: ACTIVATION_ENTITY, id: b.activationId };
  if (b.productIds?.length) data.sg_product = b.productIds.map((id) => ({ type: PRODUCT_ENTITY, id }));

  const client = Client.from(req);
  const created = await client.create("Sequence", data);
  return client.json({
    id: created.id,
    code: created.code ?? code,
    sg_activations: created.sg_activations ?? null,
    sg_product: created.sg_product ?? [],
    sg_deliverable: created.sg_deliverable ?? [],
  });
});

export const config: Config = { path: "/api/sequences", method: "POST" };
