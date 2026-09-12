/**
 * creatorProductWorkflow — Creator Studio Phase D/E: the first complete
 * end-to-end workflow (product/ad shots), extended with version history and
 * estimate-first cost tracking. Orchestrates upload -> persisted product
 * asset -> generated anchored promotional shot:
 *   1. uploadProductImages()  — multer upload -> CreatorStudioApiClient
 *   2. createProductAsset()   — persists a `product` asset (global library)
 *   3. generateAnchoredShot() — WayIllustrateAdapter generation, recorded as
 *      a `product_shot` task (queued -> completed/failed reported by this
 *      client, since a single image call has no long-running job to poll).
 *      createTask() itself records an is_estimate=1 cost row server-side
 *      before generation runs (see routes/creatorTasks.js); on success this
 *      records the matching is_estimate=0 "actual" row using that same
 *      figure (WayIllustrateAdapter never returns a real per-call dollar
 *      amount) and a new version row rather than overwriting the asset's
 *      reference image in place — every regeneration stays recoverable.
 *
 * Image generation itself reuses WayIllustrateAdapter.generateIllustration
 * (Phase B's existing BYOK/managed image path) rather than a new provider —
 * this phase proves the upload+asset+task+cost+version loop, not a new image
 * backend.
 */
import { generateIllustration } from "./WayIllustrateAdapter.js";
import {
  uploadFiles,
  createAsset,
  updateAsset,
  createTask,
  completeTask,
  failTask,
  recordVersion,
} from "./CreatorStudioApiClient.js";

export async function uploadProductImages(files) {
  if (!files?.length) throw new Error("Select at least one product image to upload.");
  return uploadFiles(files);
}

export async function createProductAsset({ name, description, referenceImagePath }) {
  const cleanName = String(name || "").trim();
  if (!cleanName) throw new Error("Product name is required.");
  return createAsset({
    assetType: "product",
    name: cleanName,
    definition: { description: String(description || "").trim() },
    referenceImagePath: referenceImagePath || null,
    source: "uploaded",
  });
}

function buildAnchoredPrompt(asset, extraPrompt) {
  const description = asset?.definition_json
    ? (typeof asset.definition_json === "string" ? JSON.parse(asset.definition_json) : asset.definition_json)?.description
    : "";
  const parts = [
    `Professional product photography of "${asset.name}"`,
    description,
    extraPrompt,
    "studio lighting, clean background, commercial ad shot",
  ].filter(Boolean);
  return parts.join(", ");
}

/**
 * Generates a promotional shot anchored to a previously-created product asset,
 * recording the attempt as a `product_shot` task/cost row throughout.
 * @param {{asset: object, prompt?: string, style?: string, aspectRatio?: string}} options
 */
export async function generateAnchoredShot({ asset, prompt = "", style = "realistic", aspectRatio = "1:1" }, accountManager = null) {
  if (!asset?.id) throw new Error("A product asset is required before generating a shot.");

  const task = await createTask({
    taskType: "product_shot",
    mediaType: "image",
    resourceId: asset.id,
    resourceType: "asset",
    payload: { prompt, style, aspectRatio },
  });

  try {
    const finalPrompt = buildAnchoredPrompt(asset, prompt);
    const generated = await generateIllustration({ prompt: finalPrompt, style, aspectRatio }, accountManager);

    const submittedPayload = typeof task.payload_json === "string" ? JSON.parse(task.payload_json) : task.payload_json;

    await completeTask(task.id, {
      result: { url: generated.url, provider: generated.provider, model: generated.model, prompt: finalPrompt },
      cost: {
        callType: "image",
        provider: generated.provider,
        model: generated.model || "unknown",
        costAmount: submittedPayload?.estimatedCostAmount || 0,
        currency: submittedPayload?.estimatedCostCurrency || "USD",
        isEstimate: false,
      },
    });

    const version = await recordVersion({
      resourceType: "product",
      resourceId: asset.id,
      filePath: generated.url,
      metadata: { prompt: finalPrompt, provider: generated.provider, model: generated.model, taskId: task.id },
    });
    await updateAsset(asset.id, { referenceImagePath: generated.url, currentVersionId: version.id });

    return generated;
  } catch (err) {
    await failTask(task.id, { errorCode: "generation_failed", errorMessage: String(err?.message || err) }).catch(() => {});
    throw err;
  }
}
