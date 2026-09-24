import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { IronClient, UsageReport } from '@iron-proxy/core';
import { AccountSwitcher, UsagePanel } from '../src/index.js';
import { FakeIronClient } from './FakeIronClient.js';

const totals = (requests: number, inputTokens = 0, outputTokens = 0) => ({
  requests,
  inputTokens,
  outputTokens,
});

function report(
  profileId: string,
  r: { h5: number; h24: number; d7: number; parks?: number; estimate?: UsageReport['estimate'] },
): UsageReport {
  return {
    profileId,
    windows: {
      '1h': totals(r.h5),
      '5h': totals(r.h5),
      '24h': totals(r.h24),
      '7d': totals(r.d7, 12_300, 4_500),
    },
    parks7d: r.parks ?? 0,
    ...(r.estimate ? { estimate: r.estimate } : {}),
  };
}

function seeded() {
  const client = new FakeIronClient();
  client.seed({ id: 'a', title: 'Work Claude', provider: 'anthropic' }, { status: 'active' });
  client.seed({ id: 'o', title: 'ChatGPT Plus', provider: 'openai', lane: 'cli' });
  client.usage = [
    report('a', {
      h5: 4,
      h24: 10,
      d7: 20,
      parks: 2,
      estimate: { minutesLeft: 40, basis: 'utilisation-trend', confidence: 'medium' },
    }),
    report('o', { h5: 0, h24: 1, d7: 5 }),
  ];
  return client;
}

describe('Usage panel', () => {
  it('the switcher header toggles the panel, which shows bars, tokens, parks and the estimate', async () => {
    const client = seeded();
    render(<AccountSwitcher client={client} injectStyles={false} />);
    await screen.findByText('Work Claude');
    expect(screen.queryByTestId('usage-panel')).toBeNull();
    expect(client.calls.some((c) => c.startsWith('usageReport'))).toBe(false);

    const toggle = screen.getByTestId('usage-toggle');
    expect(toggle.textContent).toBe('Usage');
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-pressed')).toBe('true');

    const panel = await screen.findByTestId('usage-panel');
    const work = await within(panel).findByTestId('usage-a');
    expect(within(work).getByText('Work Claude')).toBeTruthy();
    const bar5 = screen.getByTestId('usage-bar-a-5h');
    expect(bar5.getAttribute('aria-valuenow')).toBe('4');
    expect(bar5.getAttribute('aria-valuemax')).toBe('20');
    expect(bar5.getAttribute('aria-label')).toBe('4 requests in the last 5h');
    expect((bar5.firstElementChild as HTMLElement).style.width).toBe('20%');
    expect(
      (screen.getByTestId('usage-bar-a-7d').firstElementChild as HTMLElement).style.width,
    ).toBe('100%');
    expect(within(work).getByText('This week: 12k tokens in · 4.5k out')).toBeTruthy();
    expect(within(work).getByText('Parked 2× this week')).toBeTruthy();
    expect(screen.getByTestId('usage-estimate-a').textContent).toBe(
      'About 40 min left at this pace',
    );
    const other = screen.getByTestId('usage-o');
    expect(within(other).getByText('Not parked this week')).toBeTruthy();
    expect(screen.queryByTestId('usage-estimate-o')).toBeNull();

    fireEvent.click(toggle);
    expect(screen.queryByTestId('usage-panel')).toBeNull();
  });

  it('reloads after a request.finished event and marks a low-confidence estimate as rough', async () => {
    const client = seeded();
    render(<AccountSwitcher client={client} injectStyles={false} />);
    await screen.findByText('Work Claude');
    fireEvent.click(screen.getByTestId('usage-toggle'));
    await screen.findByTestId('usage-estimate-a');
    expect(screen.queryByTestId('usage-estimate-o')).toBeNull();
    const before = client.calls.filter((c) => c.startsWith('usageReport')).length;

    client.usage = [
      report('a', { h5: 5, h24: 11, d7: 21, parks: 2 }),
      report('o', {
        h5: 1,
        h24: 2,
        d7: 6,
        estimate: { minutesLeft: 12, basis: 'utilisation-trend', confidence: 'low' },
      }),
    ];
    act(() => {
      client.emit({
        type: 'request.finished',
        requestId: 'r1',
        provider: 'openai',
        profileId: 'o',
        durationMs: 5,
      });
      // A burst of events is debounced into one reload.
      client.emit({
        type: 'profile.parked',
        profileId: 'a',
        reason: { kind: 'rate-limit', source: 'status' },
      });
    });
    const est = await screen.findByTestId('usage-estimate-o', {}, { timeout: 3000 });
    expect(est.textContent).toBe('About 12 min left at this pace · rough estimate');
    expect(screen.getByTestId('usage-bar-a-5h').getAttribute('aria-valuenow')).toBe('5');
    expect(screen.queryByTestId('usage-estimate-a')).toBeNull();
    expect(client.calls.filter((c) => c.startsWith('usageReport')).length).toBe(before + 1);
  });

  it('works standalone: loads titles itself, honours labels, and shows an empty state', async () => {
    const client = seeded();
    const { unmount } = render(
      <UsagePanel
        client={client}
        injectStyles={false}
        theme="dark"
        labels={{ usageEstimate: 'Roughly {minutes} minutes to go' }}
      />,
    );
    const work = await screen.findByTestId('usage-a');
    await within(work).findByText('Work Claude');
    expect(screen.getByTestId('usage-estimate-a').textContent).toBe('Roughly 40 minutes to go');
    expect(screen.getByTestId('usage-panel').parentElement?.getAttribute('data-theme')).toBe(
      'dark',
    );
    unmount();

    const empty = new FakeIronClient();
    render(<UsagePanel client={empty} injectStyles={false} />);
    await screen.findByText('No usage recorded yet.');
  });

  it('shows the error banner (message, code, hint) instead of the empty state when usageReport fails', async () => {
    class FailingClient extends FakeIronClient {
      override async usageReport(profileId?: string): Promise<UsageReport[]> {
        this.calls.push(`usageReport:${profileId ?? '*'}`);
        throw Object.assign(new Error('Usage history could not be read.'), {
          code: 'INTERNAL',
          hint: 'Restart the app to rebuild it.',
        });
      }
    }
    const client = new FailingClient();
    client.seed({ id: 'a', title: 'Work Claude', provider: 'anthropic' });
    const { unmount } = render(<UsagePanel client={client} injectStyles={false} />);
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('Usage history could not be read.')).toBeTruthy();
    expect(within(alert).getByText('INTERNAL')).toBeTruthy();
    expect(within(alert).getByTestId('error-hint').textContent).toBe(
      'Restart the app to rebuild it.',
    );
    expect(within(alert).getByText('Something went wrong')).toBeTruthy();
    expect(screen.queryByText('No usage recorded yet.')).toBeNull();
    unmount();

    // Inside the switcher too, with the switcher's labels.
    render(
      <AccountSwitcher
        client={client}
        injectStyles={false}
        labels={{ errorPrefix: 'Could not load usage' }}
      />,
    );
    await screen.findByText('Work Claude');
    fireEvent.click(screen.getByTestId('usage-toggle'));
    const panel = await screen.findByTestId('usage-panel');
    const inline = await within(panel).findByRole('alert');
    expect(within(inline).getByText('Could not load usage')).toBeTruthy();
    expect(within(inline).getByText('Usage history could not be read.')).toBeTruthy();
    expect(within(panel).queryByText('No usage recorded yet.')).toBeNull();
  });

  it('an older client without usageReport renders the empty state instead of failing', async () => {
    const client = seeded();
    const legacy = new Proxy(client, {
      get(target, prop, recv) {
        if (prop === 'usageReport') return undefined;
        return Reflect.get(target, prop, recv) as unknown;
      },
    }) as unknown as IronClient;
    render(<UsagePanel client={legacy} injectStyles={false} />);
    await screen.findByText('No usage recorded yet.');
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });
});
