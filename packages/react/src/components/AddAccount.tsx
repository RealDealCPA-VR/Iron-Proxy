import { useState } from 'react';
import type { LaneKind, Profile, ProviderId } from '@iron-proxy/core';
import { useSwitcher } from './context.js';
import { LoginPanel } from './LoginPanel.jsx';
import { IconClose } from './icons.jsx';
import { suggestTitle } from '../util.js';

export interface AddAccountProps {
  onClose: () => void;
  /** Restrict the provider choices. */
  providers?: ProviderId[] | undefined;
}

type Step = 'provider' | 'lane' | 'details' | 'login';

const LANE_ORDER: LaneKind[] = ['cli', 'api-key', 'oauth'];

export function AddAccount({ onClose, providers }: AddAccountProps) {
  const { labels, view, providerName } = useSwitcher();
  const [step, setStep] = useState<Step>('provider');
  const [provider, setProvider] = useState<ProviderId | undefined>();
  const [lane, setLane] = useState<LaneKind | undefined>();
  const [title, setTitle] = useState('');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<Profile | undefined>();

  const available = view.providers.filter((p) => !providers || providers.includes(p.id));
  const info = available.find((p) => p.id === provider);
  const lanes = LANE_ORDER.filter((l) => info?.lanes.includes(l));

  const laneLabel = (l: LaneKind) =>
    l === 'cli' ? labels.laneCli : l === 'api-key' ? labels.laneApiKey : labels.laneOauth;
  const laneHelp = (l: LaneKind) =>
    l === 'cli'
      ? labels.laneCliHelp
      : l === 'api-key'
        ? labels.laneApiKeyHelp
        : labels.laneOauthHelp;

  const pickProvider = (id: ProviderId) => {
    setProvider(id);
    setTitle(suggestTitle(id, view.profiles));
    const p = available.find((x) => x.id === id);
    const offered = LANE_ORDER.filter((l) => p?.lanes.includes(l));
    if (offered.length === 1) {
      setLane(offered[0]);
      setStep('details');
    } else {
      setLane(undefined);
      setStep('lane');
    }
  };

  const needsBaseUrl = provider === 'openai-compatible' && lane === 'api-key';
  const canCreate =
    !!provider &&
    !!lane &&
    title.trim().length > 0 &&
    (lane !== 'api-key' || apiKey.length > 0) &&
    (!needsBaseUrl || baseUrl.trim().length > 0);

  const create = async () => {
    if (!provider || !lane || !canCreate) return;
    setBusy(true);
    const input = {
      title: title.trim(),
      provider,
      lane,
      ...(model.trim() ? { defaultModel: model.trim() } : {}),
      ...(lane === 'api-key'
        ? {
            apiKeySecret: apiKey,
            apiKey: { secretRef: '', ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}) },
          }
        : {}),
      ...(lane === 'oauth' ? { oauth: { secretRef: '', extension: 'default' } } : {}),
    };
    // secretRef is assigned by the manager; an empty one means "generate".
    if (input.apiKey && !input.apiKey.secretRef)
      delete (input.apiKey as { secretRef?: string }).secretRef;
    const p = await view.actions.create(input as Parameters<typeof view.actions.create>[0]);
    setApiKey('');
    setBusy(false);
    if (!p) return;
    setCreated(p);
    if (lane === 'cli' || lane === 'oauth') {
      setStep('login');
      void view.actions.login(p.id);
    } else {
      onClose();
    }
  };

  const steps: Step[] = ['provider', 'lane', 'details'];
  const stepLabel = (s: Step) =>
    s === 'provider'
      ? labels.addStepProvider
      : s === 'lane'
        ? labels.addStepLane
        : labels.addStepDetails;

  return (
    <section className="iron-panel" aria-label={labels.addAccount} data-testid="add-account">
      <div className="iron-panel-head">
        <h3>{labels.addAccount}</h3>
        <button
          type="button"
          className="iron-btn iron-btn--icon iron-btn--ghost"
          aria-label={labels.cancel}
          onClick={onClose}
        >
          <IconClose />
        </button>
      </div>

      {step !== 'login' ? (
        <div className="iron-steps" aria-hidden>
          {steps.map((s) => (
            <span key={s} {...(s === step ? { 'aria-current': 'step' as const } : {})}>
              {stepLabel(s)}
            </span>
          ))}
        </div>
      ) : null}

      {step === 'provider' ? (
        <div className="iron-choices" role="group" aria-label={labels.addStepProvider}>
          {available.map((p) => (
            <button
              key={p.id}
              type="button"
              className="iron-choice"
              aria-pressed={provider === p.id}
              onClick={() => pickProvider(p.id)}
            >
              <strong>{p.displayName}</strong>
              <small>{p.lanes.map(laneLabel).join(' · ')}</small>
            </button>
          ))}
        </div>
      ) : null}

      {step === 'lane' ? (
        <>
          <div className="iron-choices" role="group" aria-label={labels.addStepLane}>
            {lanes.map((l) => (
              <button
                key={l}
                type="button"
                className="iron-choice"
                aria-pressed={lane === l}
                onClick={() => {
                  setLane(l);
                  setStep('details');
                }}
              >
                <strong>{laneLabel(l)}</strong>
                <small>{laneHelp(l)}</small>
              </button>
            ))}
          </div>
          <div className="iron-panel-actions">
            <button type="button" className="iron-btn" onClick={() => setStep('provider')}>
              {labels.back}
            </button>
          </div>
        </>
      ) : null}

      {step === 'details' && provider && lane ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <div className="iron-help" style={{ marginBottom: 10 }}>
            {providerName(provider)} · {laneLabel(lane)} — {laneHelp(lane)}
          </div>
          <div className="iron-field">
            <label className="iron-label" htmlFor="iron-add-title">
              {labels.addTitleLabel}
            </label>
            <input
              id="iron-add-title"
              className="iron-input"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              autoFocus
            />
          </div>
          {lane === 'api-key' ? (
            <div className="iron-field">
              <label className="iron-label" htmlFor="iron-add-key">
                {labels.addApiKeyLabel}
              </label>
              <input
                id="iron-add-key"
                className="iron-input"
                type="password"
                autoComplete="off"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
              />
              <div className="iron-help">{labels.laneApiKeyHelp}</div>
            </div>
          ) : null}
          {needsBaseUrl ? (
            <div className="iron-field">
              <label className="iron-label" htmlFor="iron-add-base">
                {labels.addBaseUrlLabel}
              </label>
              <input
                id="iron-add-base"
                className="iron-input"
                placeholder="http://127.0.0.1:11434/v1"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
              />
              <div className="iron-help">{labels.addBaseUrlHelp}</div>
            </div>
          ) : null}
          <div className="iron-field">
            <label className="iron-label" htmlFor="iron-add-model">
              {labels.addModelLabel}
            </label>
            <input
              id="iron-add-model"
              className="iron-input"
              placeholder={info?.defaultModel ?? ''}
              value={model}
              onChange={(e) => setModel(e.target.value)}
            />
          </div>
          <div className="iron-panel-actions">
            <button
              type="button"
              className="iron-btn"
              onClick={() => setStep(lanes.length > 1 ? 'lane' : 'provider')}
            >
              {labels.back}
            </button>
            <button
              type="submit"
              className="iron-btn iron-btn--primary"
              disabled={!canCreate || busy}
            >
              {labels.create}
            </button>
          </div>
        </form>
      ) : null}

      {step === 'login' && created ? (
        <>
          <div className="iron-help" style={{ marginBottom: 10 }}>
            <strong>{created.title}</strong> · {providerName(created.provider)}
          </div>
          <LoginPanel profileId={created.id} onClose={onClose} />
        </>
      ) : null}
    </section>
  );
}
