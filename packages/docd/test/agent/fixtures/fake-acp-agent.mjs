// A minimal ACP agent over stdio, for AcpRunner's child-process tests: it offers an
// "ask" and a "read-only" mode, records the mode it is switched into, and answers each
// prompt with its pid and current mode.
import { Readable, Writable } from "node:stream";
import { agent, methods, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";

let mode = "ask";
const app = agent({ name: "fake-acp-agent" })
  .onRequest(methods.agent.initialize, () => ({ protocolVersion: PROTOCOL_VERSION, agentCapabilities: {} }))
  .onRequest(methods.agent.session.new, () => ({
    sessionId: "child-1",
    modes: {
      currentModeId: mode,
      availableModes: [
        { id: "ask", name: "Ask" },
        { id: "read-only", name: "Read only" },
      ],
    },
  }))
  .onRequest(methods.agent.session.setMode, ({ params }) => {
    mode = params.modeId;
    return {};
  })
  .onRequest(methods.agent.session.prompt, async ({ params, client }) => {
    await client.notify(methods.client.session.update, {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: `pid ${process.pid} mode ${mode}` },
      },
    });
    return { stopReason: "end_turn" };
  });

app.connect(ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
process.stderr.write("fake agent ready\n");
