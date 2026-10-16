/**
 * Sent once at initialize, so they cost no tool. Kept to the three habits that
 * close the loop: read the brief first, leave a receipt when a chat decides or
 * stalls, and never settle a person's decision for them. The server is built
 * before the tool profile is known, so no sentence may depend on one profile.
 */
export const ORGX_SERVER_INSTRUCTIONS = [
  'Before acting on an initiative, call orgx_inspect on it: the result carries the brief (goal, decisions in effect, constraints, blockers) that other agents and clients already gathered.',
  'When this conversation decides something or gets blocked, offer to record it as a work receipt (orgx_submit_work_receipt, where this connection offers it) so the next agent starts from it.',
  'Never approve, reject or settle a decision on the person\'s behalf; show it to them and let them decide in OrgX or the OrgX panel.',
].join(' ');
