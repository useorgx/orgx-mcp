"use strict";
var OrgXPanelState = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // src/panelInteractionState.ts
  var panelInteractionState_exports = {};
  __export(panelInteractionState_exports, {
    isFinalRuling: () => isFinalRuling,
    statusTransition: () => statusTransition
  });
  function isFinalRuling(phase) {
    return ["confirmed", "rejected", "failed", "elsewhere"].includes(phase);
  }
  function statusTransition(value, id, action) {
    if (!value || typeof value !== "object") return { phase: "recorded", next: null };
    const status = value;
    if (status.kind !== "decision" || status.id !== id) return { phase: "recorded", next: null };
    if (status.next_poll_after_ms === null) {
      if (status.state === "succeeded") {
        const outcome = String(status.outcome ?? "").toLowerCase();
        const approved = ["approved", "accepted", "confirmed"].includes(outcome);
        const rejected = ["rejected", "declined", "denied"].includes(outcome);
        if (action === "approve" && rejected || action === "reject" && approved) return { phase: "elsewhere", next: null, status: outcome };
        if (!approved && !rejected) return { phase: "recorded", next: null };
        return { phase: action === "approve" ? "confirmed" : "rejected", next: null };
      }
      if (status.state === "failed" || status.state === "cancelled") return { phase: "failed", next: null };
      return { phase: "recorded", next: null };
    }
    if (["queued", "held", "running"].includes(status.state ?? "") && typeof status.next_poll_after_ms === "number" && Number.isFinite(status.next_poll_after_ms)) {
      return { phase: "waiting", next: Math.min(Math.max(status.next_poll_after_ms, 400), 15e3) };
    }
    return { phase: "recorded", next: null };
  }
  return __toCommonJS(panelInteractionState_exports);
})();
