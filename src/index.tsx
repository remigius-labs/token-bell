import { ButtonItem, Focusable, Navigation, PanelSection, PanelSectionRow, TextField, staticClasses } from "@decky/ui";
import { addEventListener, removeEventListener, callable, definePlugin, toaster, useQuickAccessVisible } from "@decky/api";
import { useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { FaBell, FaBellSlash } from "react-icons/fa";

interface Limit {
  label: string;
  percent: number;
  resets_at: number | null; // seconds since 1970
  bell: boolean;
}
interface UsageState {
  limits: Limit[];
  updated: number;
  error: string | null;
  plan: string;
  stale?: boolean;
  signed_in?: boolean;
}
interface LoginState {
  step: "idle" | "installing" | "starting" | "code" | "checking" | "error";
  url?: string;
  error?: string;
}

const getState = callable<[], { usage: UsageState; login: LoginState }>("get_state");
const refreshUsage = callable<[force: boolean], void>("refresh_usage");
const setBell = callable<[label: string, on: boolean], void>("set_bell");
const loginStart = callable<[], void>("login_start");
const loginCode = callable<[code: string], void>("login_code");
const loginCancel = callable<[], void>("login_cancel");

// Lives outside React: the panel is unmounted whenever the Quick Access Menu closes.
const store = {
  usage: { limits: [], updated: 0, error: null, plan: "" } as UsageState,
  login: { step: "idle" } as LoginState,
  code: "",
  listeners: new Set<() => void>(),
};

function changed() {
  store.listeners.forEach((l) => l());
}

function useStore() {
  const [, setTick] = useState(0);
  useEffect(() => {
    const listener = () => setTick((t) => t + 1);
    store.listeners.add(listener);
    return () => {
      store.listeners.delete(listener);
    };
  }, []);
}

function onUsage(usage: UsageState, resets: string[], login: LoginState) {
  store.usage = usage;
  if (login.step === "idle") store.code = "";
  store.login = login;
  for (const label of resets)
    toaster.toast({ title: "Token Bell: Claude limit reset", body: `${label} is back to full.`, duration: 10000, critical: true });
  changed();
}

function toggleBell(limit: Limit) {
  limit.bell = !limit.bell; // shown at once; the backend's answer follows
  changed();
  setBell(limit.label, limit.bell);
}

function untilReset(resetsAt: number | null) {
  if (!resetsAt) return "";
  const minutes = Math.round((resetsAt - Date.now() / 1000) / 60);
  if (minutes <= 0) return "resetting now";
  if (minutes < 60) return `resets in ${minutes} min`;
  if (minutes < 24 * 60) return `resets in ${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")} min`;
  const when = new Date(resetsAt * 1000);
  return `resets ${when.toLocaleDateString(undefined, { weekday: "short" })} ${when.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`;
}

const CSS = `
.cc-usage { font-size: 12px; }
.cc-plan { font-weight: bold; margin-bottom: 4px; }
.cc-limit { display: flex; align-items: center; gap: 8px; padding: 5px 4px; border-radius: 3px; }
.cc-limit.gpfocus { background: rgba(255, 255, 255, 0.12); }
.cc-limit-main { flex: 1; min-width: 0; }
.cc-limit-text { display: flex; justify-content: space-between; opacity: 0.85; }
.cc-bell { font-size: 15px; display: flex; color: #d97757; }
.cc-bell.cc-off { color: inherit; opacity: 0.35; }
.cc-bar { height: 4px; border-radius: 2px; background: rgba(255, 255, 255, 0.15); margin-top: 3px; overflow: hidden; }
.cc-bar > div { height: 100%; background: #d97757; }
.cc-bar > div.cc-bar-high { background: #ff5252; }
.cc-error { color: #ff8a80; }
.cc-empty { opacity: 0.6; }
.cc-login { font-size: 12px; line-height: 1.4; }
.cc-qr { background: #fff; padding: 8px; border-radius: 4px; margin: 6px auto; width: fit-content; display: flex; }
`;

// Claude Code does the signing in (see Login in main.py); this shows its page and takes the code back.
function SignIn() {
  const { login } = store;
  if (login.step === "installing" || login.step === "starting" || login.step === "checking") {
    const what = { installing: "Installing Claude Code…", starting: "Starting the sign-in…", checking: "Checking the code…" };
    return (
      <PanelSectionRow>
        <div className="cc-login">{what[login.step]}</div>
      </PanelSectionRow>
    );
  }
  if (login.step === "code" && login.url)
    return (
      <>
        <PanelSectionRow>
          <div className="cc-login">
            Sign in to Claude on your phone with this code, or open the page here. Then type the code it shows you.
            <div className="cc-qr">
              <QRCodeSVG value={login.url} size={220} level="L" />
            </div>
            {login.error && <div className="cc-error">{login.error}</div>}
          </div>
        </PanelSectionRow>
        <PanelSectionRow>
          <ButtonItem layout="below" onClick={() => Navigation.NavigateToExternalWeb(login.url!)}>
            Open the page here
          </ButtonItem>
        </PanelSectionRow>
        <PanelSectionRow>
          <TextField
            label="Code"
            value={store.code}
            onChange={(e) => {
              store.code = e.target.value;
              changed();
            }}
          />
        </PanelSectionRow>
        <PanelSectionRow>
          <ButtonItem layout="below" disabled={!store.code.trim()} onClick={() => loginCode(store.code)}>
            Finish sign-in
          </ButtonItem>
        </PanelSectionRow>
        <PanelSectionRow>
          <ButtonItem layout="below" onClick={() => loginCancel()}>
            Cancel
          </ButtonItem>
        </PanelSectionRow>
      </>
    );
  return (
    <>
      {login.step === "error" && (
        <PanelSectionRow>
          <div className="cc-login cc-error">{login.error}</div>
        </PanelSectionRow>
      )}
      <PanelSectionRow>
        <ButtonItem layout="below" onClick={() => loginStart()}>
          {store.usage.signed_in ? "Sign in again" : "Sign in to Claude"}
        </ButtonItem>
      </PanelSectionRow>
    </>
  );
}

// Laid out after Omarchy's Agents panel: plan, then a meter and time-to-reset per limit.
function Content() {
  useStore();
  const visible = useQuickAccessVisible();

  useEffect(() => {
    getState().then((s) => {
      store.usage = s.usage;
      store.login = s.login;
      changed();
    });
  }, []);

  // fresh numbers when the menu opens, and a ticking countdown while it is open
  useEffect(() => {
    if (!visible) return;
    if (Date.now() / 1000 - store.usage.updated > 60) refreshUsage(false);
    const tick = setInterval(changed, 30000);
    return () => clearInterval(tick);
  }, [visible]);

  const { usage } = store;
  return (
    <PanelSection>
      <style>{CSS}</style>
      <PanelSectionRow>
        <div className="cc-usage">
          {usage.plan && <div className="cc-plan">Claude Code · {usage.plan}</div>}
          {!usage.limits.length && !usage.error && usage.signed_in !== false && <div className="cc-empty">Reading usage…</div>}
          {usage.signed_in === false && <div className="cc-empty">Sign in with your Claude account to see your limits.</div>}
          <div style={usage.stale ? { opacity: 0.5 } : undefined}>
            {usage.limits.map((limit) => (
              <Focusable
                key={limit.label}
                className="cc-limit"
                noFocusRing
                onActivate={() => toggleBell(limit)}
                onClick={() => toggleBell(limit)}
                onOKActionDescription={limit.bell ? "Don't ping on reset" : "Ping on reset"}
              >
                <div className="cc-limit-main">
                  <div className="cc-limit-text">
                    <span>
                      {limit.label} <b>{limit.percent}%</b>
                    </span>
                    <span>{untilReset(limit.resets_at)}</span>
                  </div>
                  <div className="cc-bar">
                    <div className={limit.percent >= 80 ? "cc-bar-high" : ""} style={{ width: `${Math.min(100, limit.percent)}%` }} />
                  </div>
                </div>
                <div className={`cc-bell${limit.bell ? "" : " cc-off"}`}>{limit.bell ? <FaBell /> : <FaBellSlash />}</div>
              </Focusable>
            ))}
          </div>
          {usage.error && <div className="cc-error">{usage.error}</div>}
        </div>
      </PanelSectionRow>
      {(usage.signed_in === false || store.login.step !== "idle" || (usage.error ?? "").includes("expired")) && <SignIn />}
      <PanelSectionRow>
        <ButtonItem layout="below" onClick={() => refreshUsage(true)}>
          Refresh
        </ButtonItem>
      </PanelSectionRow>
    </PanelSection>
  );
}

export default definePlugin(() => {
  addEventListener<[UsageState, string[], LoginState]>("claude_usage", onUsage);
  getState().then((s) => {
    store.usage = s.usage; // so a reset can be announced before the panel was ever opened
  });

  return {
    name: "Token Bell",
    titleView: <div className={staticClasses.Title}>Token Bell</div>,
    content: <Content />,
    icon: <FaBell />,
    onDismount() {
      removeEventListener("claude_usage", onUsage);
    },
  };
});
