/**
 * Joining and leaving the shared session on the Croquet-in-a-Box reflector.
 * The view half lives here too: it forwards local input to the model and model events to the scene.
 */
import * as Croquet from '@croquet/croquet';
import { initPhysics } from '../game/physics';
import type { CarInput, GameEvent, PlayerId } from '../game/types';
import { SCOPE, SumoModel, type OnlineRules } from './model';

/**
 * Croquet-in-a-Box: reflector at <box>reflector, snapshot/file server at <box>files.
 * Set VITE_CROQUET_BOX in .env.local (not committed), e.g. https://example.org/croquet/
 */
export const REFLECTOR_BOX: string = import.meta.env.VITE_CROQUET_BOX ?? '';
const APP_ID = 'jp.hebovr.rc-sumo-arena';

/** Set by the app: where model events and per-frame updates go. */
export const onlineHooks = {
  events: (_events: GameEvent[]) => {},
  changed: () => {},
};

export class SumoView extends Croquet.View {
  model: SumoModel;
  synced = false;

  constructor(model: SumoModel) {
    super(model);
    this.model = model;
    this.subscribe(SCOPE, 'events', this.onEvents);
    this.subscribe(this.viewId, 'synced', this.onSynced);
    onlineHooks.changed();
  }

  onSynced(synced: boolean) {
    this.synced = synced;
    onlineHooks.changed();
  }

  /** Model-to-view events: sounds, sparks, banners. Skipped while catching up on join. */
  onEvents(events: GameEvent[]) {
    if (this.synced) onlineHooks.events(events);
  }

  get seat(): PlayerId | null {
    return this.model.seatOf(this.viewId);
  }

  sendInput(input: CarInput) {
    this.publish(SCOPE, 'input', { viewId: this.viewId, ...input });
  }

  sendStart() {
    this.publish(SCOPE, 'start');
  }

  sendPause() {
    this.publish(SCOPE, 'pause');
  }

  sendTitle() {
    this.publish(SCOPE, 'title');
  }

  sendRules(patch: Partial<OnlineRules>) {
    this.publish(SCOPE, 'rules', patch);
  }

  detach() {
    super.detach();
    onlineHooks.changed();
  }
}

let session: Croquet.CroquetSession<SumoView> | null = null;
let joining: Promise<void> | null = null;

// Croquet may rebuild the root view after a reconnect, so always ask the session for it.
export const currentView = (): SumoView | null => session?.view ?? null;
export const currentModel = (): SumoModel | null => currentView()?.model ?? null;
export const sessionUrl = () => (session ? window.location.href : '');

/** Is there a session in this page's URL (someone shared a link)? */
export const urlHasSession = () => new URLSearchParams(window.location.search).has('q');

export function connectOnline() {
  joining ??= (async () => {
    if (!REFLECTOR_BOX) throw new Error('VITE_CROQUET_BOX is not set');
    await initPhysics();
    const name = await Croquet.App.autoSession();
    const password = await Croquet.App.autoPassword();
    session = await Croquet.Session.join({
      box: REFLECTOR_BOX,
      apiKey: 'none',
      appId: APP_ID,
      name,
      password,
      model: SumoModel,
      view: SumoView,
      tps: 60,
    });
    onlineHooks.changed();
  })().finally(() => {
    joining = null;
  });
  return joining;
}

export async function leaveOnline() {
  const leaving = session;
  session = null;
  await leaving?.leave();
  // Drop ?q= and #pw= so a reload starts offline.
  const url = new URL(window.location.href);
  url.searchParams.delete('q');
  url.hash = '';
  window.history.replaceState(null, '', url.toString());
  onlineHooks.changed();
}

export const isOnline = () => session !== null;
