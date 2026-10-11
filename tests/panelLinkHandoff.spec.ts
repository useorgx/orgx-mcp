// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mountPanel, snapshot } from './fixtures/panel';

let mounted: Awaited<ReturnType<typeof mountPanel>>;
afterEach(() => mounted?.dom.window.close());

describe('panel links while the SDK handshake is pending', () => {
  it('renders ChatGPT globals and opens the decision through ChatGPT immediately', async () => {
    const openExternal = vi.fn();
    mounted = await mountPanel({}, {}, window => {
      const scope = window as any;
      const Original = scope.__FakeMcpApps.App;
      scope.__FakeMcpApps.App = class extends Original {
        connect = () => new Promise(() => {});
      };
      scope.openai = { toolOutput: snapshot(), openExternal, setWidgetHeight: vi.fn() };
      window.localStorage.setItem('orgx-panel-tour-seen', '1');
    });
    const document = mounted.dom.window.document;
    const skip = document.querySelector('[data-tour="skip"]') as HTMLButtonElement | null;
    skip?.click();
    const button = document.querySelector('button[data-action="open"]') as HTMLButtonElement;
    expect(button).not.toBeNull();
    button.click();
    expect(openExternal).toHaveBeenCalledExactlyOnceWith({ url: snapshot().focus.url });
    expect(mounted.calls.openLink).not.toHaveBeenCalled();
  });
});
