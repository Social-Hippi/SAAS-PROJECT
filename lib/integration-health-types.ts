// Provider-neutral Integration Health types.
//
// Client-safe: NO "server-only", no prisma — the dashboard renders health, so
// these types cross the JSON boundary into client components exactly like
// lib/channel-view-types.ts does.
//
// SCOPE (deliberate): today the only producer is lib/google-ads-health.ts. The
// types below are written provider-neutral from the start so that extracting a
// shared Integration Health framework later (Meta / GA4 / Snippet / Share Link)
// is a RELOCATION of this file, not a redesign. There is intentionally NO
// registry, resolver, capability framework, or probe interface yet — those get
// designed once a second integration has real Layer-3 checks to generalise from.
//
// ── The model ────────────────────────────────────────────────────────────────
// Health is three gated layers, not one status:
//
//   LINKED   — can we reach the provider?      (credential, scope, account picked)
//   FLOWING  — is data arriving?               (sync ran, recent, non-empty)
//   USABLE   — does the data answer the question we ask of it?
//              (tagging, conversion config, joinability)
//
// Layer 3 is the one a credential-only status model cannot express: a connection
// can be authenticated, syncing perfectly, and still unable to answer "what
// revenue did this channel drive?".
//
// ── The invariant ────────────────────────────────────────────────────────────
// The product must never report a negative state without saying WHY. That is
// enforced structurally: `degraded` and `failed` are DERIVED FROM diagnoses by
// deriveLayers() below, so a negative layer cannot exist without the diagnosis
// that produced it. Only the non-negative states (ok / unknown / not_applicable)
// may be asserted directly via a hint, because they make no claim to justify.

/** Resolution of one health layer. */
export type LayerState = "ok" | "degraded" | "failed" | "unknown" | "not_applicable";

export type HealthLayer = "linked" | "flowing" | "usable";

export const HEALTH_LAYERS: readonly HealthLayer[] = ["linked", "flowing", "usable"] as const;

/**
 * Impact on the ANSWER, not log level:
 *   blocking      — the capability cannot be delivered at all
 *   degrading     — delivered, but less complete/precise than it should be
 *   informational — worth surfacing, nothing is wrong (e.g. no campaigns ran)
 */
export type DiagnosisSeverity = "blocking" | "degrading" | "informational";

/**
 * confirmed — the provider told us (an auth error, an explicit empty result)
 * inferred  — we deduced it from evidence (clicks with no tagged sessions)
 *
 * The UI MUST render these differently. Presenting an inference as a fact is the
 * same class of defect this model exists to remove.
 */
export type DiagnosisConfidence = "confirmed" | "inferred";

/**
 * Who can act. Surfaces filter by viewer: a hotel owner must never be shown an
 * action only their agency can take, and never the evidence behind it (which can
 * imply ad spend — see the showAdSpendToHotel gate).
 */
export type DiagnosisAudience = "agency" | "hotel" | "platform";

/** One observation that justifies a diagnosis. Never a sentence — label + value. */
export type EvidenceItem = { label: string; value: string };

/** What the reader should do about it. */
export type Remedy = {
  /** Plain-language instruction, written for `audience`. */
  instruction: string;
  /** Deep link to the place the fix is made, when one exists in-product. */
  href?: string;
  /** Payload the user pastes elsewhere (e.g. a URL suffix), for a copy button. */
  copyText?: string;
};

/**
 * A first-class explanation of why a layer is not ok. Codes are stable across
 * UI / PDF / logs; the human copy is a presentation concern chosen per audience.
 */
export type Diagnosis = {
  code: string;
  layer: HealthLayer;
  severity: DiagnosisSeverity;
  confidence: DiagnosisConfidence;
  /** One-line statement of the problem, in the reader's register. */
  summary: string;
  /** What we observed. Never assert without this. */
  evidence: EvidenceItem[];
  /** Informal capability keys this blocks, e.g. "paid.attribution". */
  capabilitiesBlocked: string[];
  audience: DiagnosisAudience;
  remedy?: Remedy;
};

export type IntegrationHealth = {
  /** Stable id, e.g. "google_ads". */
  integrationId: string;
  label: string;
  layers: Record<HealthLayer, LayerState>;
  /** Worst layer state. Derived — never set by hand. */
  overall: LayerState;
  diagnoses: Diagnosis[];
  /** ISO timestamp of assessment. */
  observedAt: string;
  /** The window the evidence was gathered over (ISO dates). */
  window: { start: string; end: string };
};

// ── Derivation ───────────────────────────────────────────────────────────────

/** Non-negative states a probe may assert directly (they justify nothing). */
export type LayerHint = Extract<LayerState, "ok" | "unknown" | "not_applicable">;

const SEVERITY_TO_STATE: Record<DiagnosisSeverity, LayerState> = {
  blocking: "failed",
  degrading: "degraded",
  informational: "ok",
};

/** Render order: the most consequential diagnosis first. */
const SEVERITY_ORDER: Record<DiagnosisSeverity, number> = {
  blocking: 0,
  degrading: 1,
  informational: 2,
};

// Worst-first, so `overall` and per-layer folding share one ordering.
const STATE_RANK: Record<LayerState, number> = {
  failed: 4,
  degraded: 3,
  unknown: 2,
  ok: 1,
  not_applicable: 0,
};

function worse(a: LayerState, b: LayerState): LayerState {
  return STATE_RANK[a] >= STATE_RANK[b] ? a : b;
}

/**
 * Derives the three layer states from the diagnoses, applying the gating rule:
 * a failed layer makes every LATER layer `unknown`, never `failed` — we cannot
 * claim data is unusable when none of it arrived.
 *
 * `hints` supply the non-negative state for a layer that emitted no diagnosis
 * (e.g. usable = "not_applicable" when there is no paid traffic to attribute).
 * A layer with neither a diagnosis nor a hint resolves to "ok".
 */
export function deriveLayers(
  diagnoses: Diagnosis[],
  hints: Partial<Record<HealthLayer, LayerHint>> = {},
): Record<HealthLayer, LayerState> {
  const out = {} as Record<HealthLayer, LayerState>;
  let gated = false;

  for (const layer of HEALTH_LAYERS) {
    if (gated) {
      out[layer] = "unknown";
      continue;
    }
    const forLayer = diagnoses.filter((d) => d.layer === layer);
    let state: LayerState = forLayer.length > 0 ? "ok" : (hints[layer] ?? "ok");
    for (const d of forLayer) state = worse(state, SEVERITY_TO_STATE[d.severity]);
    out[layer] = state;
    // Once a layer fails, everything downstream is unknowable, not broken.
    if (state === "failed") gated = true;
  }
  return out;
}

/** Worst of the three layers; `not_applicable` layers don't drag the result. */
export function deriveOverall(layers: Record<HealthLayer, LayerState>): LayerState {
  let out: LayerState = "ok";
  let sawApplicable = false;
  for (const layer of HEALTH_LAYERS) {
    const s = layers[layer];
    if (s === "not_applicable") continue;
    sawApplicable = true;
    out = worse(out, s);
  }
  return sawApplicable ? out : "not_applicable";
}

/**
 * Assembles a health record. The ONLY sanctioned way to build one, so the
 * derivation (and therefore the no-silent-negative invariant) can't be bypassed.
 */
export function buildHealth(input: {
  integrationId: string;
  label: string;
  diagnoses: Diagnosis[];
  hints?: Partial<Record<HealthLayer, LayerHint>>;
  window: { start: Date; end: Date };
  now?: Date;
}): IntegrationHealth {
  const layers = deriveLayers(input.diagnoses, input.hints);
  return {
    integrationId: input.integrationId,
    label: input.label,
    layers,
    overall: deriveOverall(layers),
    // Severity order so the most consequential diagnosis renders first.
    diagnoses: [...input.diagnoses].sort(
      (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
    ),
    observedAt: (input.now ?? new Date()).toISOString(),
    window: {
      start: input.window.start.toISOString().slice(0, 10),
      end: input.window.end.toISOString().slice(0, 10),
    },
  };
}

// ── Presentation helpers (shared by dashboard + PDF) ─────────────────────────

/** The diagnoses a given viewer may see. */
export function diagnosesFor(
  health: IntegrationHealth | undefined,
  audience: DiagnosisAudience,
): Diagnosis[] {
  if (!health) return [];
  if (audience === "agency" || audience === "platform") return health.diagnoses;
  // Hotel owners see only what they can act on; agency-owned issues are
  // summarised elsewhere without leaking spend-adjacent evidence.
  return health.diagnoses.filter((d) => d.audience === "hotel");
}

/** The single most consequential diagnosis, if any. */
export function primaryDiagnosis(health: IntegrationHealth | undefined): Diagnosis | null {
  return health?.diagnoses[0] ?? null;
}

/** True when a capability is blocked by any blocking diagnosis. */
export function isCapabilityBlocked(
  health: IntegrationHealth | undefined,
  capability: string,
): boolean {
  if (!health) return false;
  return health.diagnoses.some(
    (d) => d.severity === "blocking" && d.capabilitiesBlocked.includes(capability),
  );
}

/** Tone for badges/dots, matching the vocabulary used elsewhere in the UI. */
export function healthTone(state: LayerState): "gray" | "green" | "yellow" | "red" {
  switch (state) {
    case "ok":
      return "green";
    case "degraded":
      return "yellow";
    case "failed":
      return "red";
    default:
      return "gray";
  }
}

export const LAYER_LABEL: Record<HealthLayer, string> = {
  linked: "Linked",
  flowing: "Flowing",
  usable: "Usable",
};

export const LAYER_QUESTION: Record<HealthLayer, string> = {
  linked: "Can we reach the provider?",
  flowing: "Is data arriving?",
  usable: "Can the data answer your question?",
};
