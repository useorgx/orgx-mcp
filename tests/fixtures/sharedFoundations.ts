import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The shared scripts every widget loads ahead of its own: agent identity
 * (avatars, hover cards), the runtime (OrgXTime, OrgXLinks and the host
 * bridge) and the icon set. Harnesses that stub OrgXWidgetRuntime call this
 * first, then install their stub; window.OrgXTime and window.OrgXLinks stay.
 */
const SHARED = join(__dirname, '..', '..', 'public', 'widgets', 'shared');
const SOURCES = ['agent-identity.js', 'widget-runtime.js', 'orgx-icons.js'].map((file) =>
  readFileSync(join(SHARED, file), 'utf8')
);

export function installSharedFoundations(win: { eval(source: string): unknown }): void {
  for (const source of SOURCES) win.eval(source);
}
