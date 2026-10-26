import type { ArtifactOutputFrontDoor } from '../../src/outputFrontDoor';

export const FRONT_DOOR_ARTIFACT_ID = 'a1111111-1111-4111-8111-111111111111';
export const FRONT_DOOR_DECISION_ID = '3f1c2a9e-6b7d-4c1e-9a2b-1d2e3f4a5b6c';
export const FRONT_DOOR_RUN_ID = '77777777-7777-4777-8777-777777777777';
export function outputFrontDoor(): ArtifactOutputFrontDoor {
  return {
    schemaVersion: 'artifact_output_front_door.v1',
    answer: 'Review the client deck and approve the Friday send.',
    decisions: [{ id: FRONT_DOOR_DECISION_ID, question: 'Send the deck on Friday?', recommendation: 'Send after the client review.', impact: 'The launch date stays on track.', href: `/decisions/${FRONT_DOOR_DECISION_ID}` }],
    checked: ['Read the brief and checked the package links.'],
    notChecked: ['Client acceptance has not been recorded.'],
    evidenceBasis: 'producer_reported',
    context: { state: 'partial', summary: 'The brief loaded. Budget was not recorded.', runId: FRONT_DOOR_RUN_ID },
    files: [{ artifactId: FRONT_DOOR_ARTIFACT_ID, name: 'Client deck.md', mimeType: 'text/markdown', sizeBytes: 0, purpose: 'Review copy for the client.', href: `/artifacts/${FRONT_DOOR_ARTIFACT_ID}` }],
    receipt: { href: `/console/runs/${FRONT_DOOR_RUN_ID}`, runId: FRONT_DOOR_RUN_ID, costUsd: 0, expertMinutes: 0, qualityBar: null },
  };
}
