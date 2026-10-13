#!/usr/bin/env node
// Ask the running Decky Loader to install out/token-bell.zip. Decky shows its usual
// "Install plugin?" prompt in the Steam UI; nothing is installed until that is confirmed.
// Talks to Steam's own UI through its local debugging port (the one Decky itself uses).
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const zip = resolve(root, "out/token-bell.zip");
readFileSync(zip); // fails early when tools/package.sh hasn't run
const name = JSON.parse(readFileSync(resolve(root, "plugin.json"), "utf8")).name;
const version = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).version;

export async function steamEval(expression) {
  const tabs = await (await fetch("http://localhost:8080/json")).json();
  const tab = tabs.find((t) => t.title === "SharedJSContext");
  if (!tab) throw new Error("Steam's UI isn't reachable (is Steam running with Decky?)");
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((ok, fail) => ((ws.onopen = ok), (ws.onerror = () => fail(new Error("can't connect to Steam's UI")))));
  const result = await new Promise((ok) => {
    ws.onmessage = (m) => ok(JSON.parse(m.data));
    ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
  });
  ws.close();
  if (result.result?.exceptionDetails) throw new Error(JSON.stringify(result.result.exceptionDetails.exception ?? result.result.exceptionDetails));
  return result.result?.result?.value;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes("--check");
  const plugins = await steamEval(`JSON.stringify({backend: typeof DeckyBackend, plugins: (window.DeckyPluginLoader?.plugins ?? []).map(p => p.name)})`);
  console.log("Decky:", plugins);
  if (!check) {
    await steamEval(`DeckyBackend.call("utilities/install_plugin", ${JSON.stringify("file://" + zip)}, ${JSON.stringify(name)}, ${JSON.stringify(version)}, "", 0).then(() => "asked")`);
    console.log(`Asked Decky to install ${name} ${version}: confirm the prompt in the Steam UI.`);
  }
}
