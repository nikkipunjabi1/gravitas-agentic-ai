import type { UIAction, UIActionType } from "@/canvas/schema";
import { DebugAction } from "@/canvas/components/debug-action";
import { AuditFindings } from "@/canvas/components/audit-findings";
import { MaturityChart } from "@/canvas/components/maturity-chart";
import { RoadmapWidget } from "@/canvas/components/roadmap-widget";
import { KeepAndBuildOn } from "@/canvas/components/keep-and-build-on";
import { ThemesGrid } from "@/canvas/components/themes-grid";
import { RateLimitReached } from "@/canvas/components/rate-limit-reached";
import { DailyCapReached } from "@/canvas/components/daily-cap-reached";
import { SolutionMap } from "@/canvas/components/solution-map";
import { makeStub } from "@/canvas/components/_stub";

/**
 * Canvas registry — the type → component map.
 *
 * The mapped type below makes adding a new branch to the UIAction union
 * (in schema.ts) a COMPILE ERROR until a component is registered here.
 * That's by design (UI_CONTRACT.md → Registry).
 *
 * Phase 1.5 wires all seven Phase-1 canvas components. Phase 2's three
 * (SolutionMap, TechStackReco, LeadGenForm) remain typed stubs; Phase 3's
 * ExecutiveBriefDownload likewise. Adding the real component just swaps
 * the makeStub call for the import.
 */
export const registry: {
  [K in UIActionType]: React.ComponentType<{
    action: Extract<UIAction, { type: K }>;
  }>;
} = {
  // ---- Phase 0 ------------------------------------------------------------
  DebugAction,

  // ---- Phase 1 (MVP — AI Experience Auditor) ----------------------------- ✓
  AuditFindings,
  MaturityChart,
  RoadmapWidget,
  KeepAndBuildOn,
  ThemesGrid,
  DailyCapReached,
  RateLimitReached,

  // ---- Phase 1 (promoted from Phase 2 — agent emits real data) ----------
  SolutionMap,

  // ---- Phase 2 (Multi-agent Co-Pilot) ------------------------------------
  TechStackReco: makeStub("TechStackReco", 2),
  LeadGenForm: makeStub("LeadGenForm", 2),

  // ---- Phase 3 (Autonomous Co-Pilot) -------------------------------------
  ExecutiveBriefDownload: makeStub("ExecutiveBriefDownload", 3),
};
