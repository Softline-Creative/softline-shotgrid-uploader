import type { Config } from "@netlify/functions";
import { Client, handler, project } from "../lib/shotgrid";

// Custom entity types behind the Sequence link fields. Site-specific;
// keep in step with upload_videos.py.
const ACTIVATION_ENTITY = "CustomEntity01";   // sg_activations  (single)
const PRODUCT_ENTITY = "CustomEntity02";      // sg_product      (multi)
const DELIVERABLE_ENTITY = "CustomEntity03";  // sg_deliverable  (multi)

/** Options for a custom entity, project-scoped if possible (load_entity_options). */
async function entityOptions(client: Client, entity: string) {
  let rows = await client.find(entity, [["project", "is", project()]], ["id", "code"]).catch(() => []);
  if (!rows.length) rows = await client.find(entity, [], ["id", "code"]).catch(() => []);
  return rows
    .map((r) => ({ type: entity, id: r.id as number, name: (r.code as string) || `(unnamed ${r.id})` }))
    .sort((a, b) => {
      const x = a.name.toLowerCase(), y = b.name.toLowerCase();
      return x < y ? -1 : x > y ? 1 : 0;
    });
}

/** Everything the matching screens need, in one call. */
export default handler(async (req) => {
  const client = Client.from(req);
  const [sequences, activations, products, deliverables] = await Promise.all([
    client.find("Sequence", [["project", "is", project()]],
      ["id", "code", "sg_activations", "sg_product", "sg_deliverable"]),
    entityOptions(client, ACTIVATION_ENTITY),
    entityOptions(client, PRODUCT_ENTITY),
    entityOptions(client, DELIVERABLE_ENTITY),
  ]);
  return client.json({
    sequences: sequences.map((s) => ({
      id: s.id,
      code: s.code ?? null,
      sg_activations: s.sg_activations ?? null,
      sg_product: s.sg_product ?? [],
      sg_deliverable: s.sg_deliverable ?? [],
    })),
    activations, products, deliverables,
  });
});

export const config: Config = { path: "/api/catalog", method: "GET" };
