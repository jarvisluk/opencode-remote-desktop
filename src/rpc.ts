import { Rpc } from "@opencode/plugin/rpc"
import { REMOTE_INPUT_KINDS } from "./input-types.ts"

export const BotRpc = Rpc.define({
  id: "bot",
  methods: {
    status: {
      input: { type: "object", additionalProperties: false },
      output: {
        type: "object",
        properties: {
          platform: { type: "string" },
          supported: { type: "boolean" },
          accessibility: { type: "string" },
          screenRecording: { type: "string" },
          keepAwakeActive: { type: "boolean" },
          browserMode: { type: "string" },
          streamAvailable: { type: "boolean" },
          activeTakeovers: { type: "number" },
          routineCount: { type: "number" },
          streamIdleTimeoutMs: { type: "number" },
          streamHiddenTimeoutMs: { type: "number" },
        },
        required: [
          "platform",
          "supported",
          "accessibility",
          "screenRecording",
          "keepAwakeActive",
          "browserMode",
          "streamAvailable",
          "activeTakeovers",
          "routineCount",
        ],
        additionalProperties: false,
      },
    },
    frame: {
      input: {
        type: "object",
        properties: {
          windowId: { type: "string" },
          app: { type: "string" },
          maxDimension: { type: "number" },
          quality: { type: "number" },
        },
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          jpegBase64: { type: "string" },
          imageWidth: { type: "number" },
          imageHeight: { type: "number" },
          logicalX: { type: "number" },
          logicalY: { type: "number" },
          logicalWidth: { type: "number" },
          logicalHeight: { type: "number" },
          timestamp: { type: "number" },
        },
        required: [
          "jpegBase64",
          "imageWidth",
          "imageHeight",
          "logicalX",
          "logicalY",
          "logicalWidth",
          "logicalHeight",
          "timestamp",
        ],
        additionalProperties: false,
      },
    },
    sendInput: {
      input: {
        type: "object",
        properties: {
          kind: { type: "string", enum: [...REMOTE_INPUT_KINDS] },
          x: { type: "number" },
          y: { type: "number" },
          deltaY: { type: "number" },
          text: { type: "string" },
          key: { type: "string" },
          app: { type: "string" },
        },
        required: ["kind"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          detail: { type: "string" },
        },
        required: ["ok"],
        additionalProperties: false,
      },
    },
    streamOffer: {
      input: {
        type: "object",
        properties: { sdp: { type: "string" } },
        required: ["sdp"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          sdp: { type: "string" },
          session: { type: "string" },
        },
        required: ["sdp", "session"],
        additionalProperties: false,
      },
    },
    streamClose: {
      input: {
        type: "object",
        properties: { session: { type: "string" } },
        required: ["session"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: { ok: { type: "boolean" } },
        required: ["ok"],
        additionalProperties: false,
      },
    },
    listWindows: {
      input: {
        type: "object",
        properties: {
          app: { type: "string" },
        },
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          windows: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                appName: { type: "string" },
                title: { type: "string" },
                isFocused: { type: "boolean" },
                visible: { type: "boolean" },
              },
              required: ["id", "appName", "title", "isFocused", "visible"],
              additionalProperties: false,
            },
          },
        },
        required: ["windows"],
        additionalProperties: false,
      },
    },
    focusWindow: {
      input: {
        type: "object",
        properties: {
          windowId: { type: "string" },
          app: { type: "string" },
        },
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          detail: { type: "string" },
        },
        required: ["ok"],
        additionalProperties: false,
      },
    },
    listTakeovers: {
      input: { type: "object", additionalProperties: false },
      output: {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                sessionID: { type: "string" },
                reason: { type: "string" },
                app: { type: "string" },
                createdAt: { type: "number" },
              },
              required: ["id", "sessionID", "reason", "createdAt"],
              additionalProperties: false,
            },
          },
        },
        required: ["items"],
        additionalProperties: false,
      },
    },
    viewerHeartbeat: {
      input: {
        type: "object",
        properties: {
          clientId: { type: "string" },
          platform: { type: "string", enum: ["web", "desktop"] },
          mobile: { type: "boolean" },
          sessionID: { type: "string" },
          panel: { type: "boolean" },
        },
        required: ["clientId", "platform", "mobile", "panel"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: { ok: { type: "boolean" } },
        required: ["ok"],
        additionalProperties: false,
      },
    },
    resolveTakeover: {
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          note: { type: "string" },
        },
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          resolved: { type: "number" },
        },
        required: ["resolved"],
        additionalProperties: false,
      },
    },
    listSecretRequests: {
      input: { type: "object", additionalProperties: false },
      output: {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                sessionID: { type: "string" },
                name: { type: "string" },
                reason: { type: "string" },
                createdAt: { type: "number" },
              },
              required: ["id", "sessionID", "name", "reason", "createdAt"],
              additionalProperties: false,
            },
          },
        },
        required: ["items"],
        additionalProperties: false,
      },
    },
    secretSubmit: {
      input: {
        type: "object",
        properties: {
          id: { type: "string" },
          value: { type: "string" },
        },
        required: ["id", "value"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: { ok: { type: "boolean" } },
        required: ["ok"],
        additionalProperties: false,
      },
    },
    secretCancel: {
      input: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: { ok: { type: "boolean" } },
        required: ["ok"],
        additionalProperties: false,
      },
    },
    screenState: {
      input: { type: "object", additionalProperties: false },
      output: {
        type: "object",
        properties: {
          owner: { type: "string", enum: ["idle", "agent", "human"] },
          sessionIDs: { type: "array", items: { type: "string" } },
          tool: { type: "string" },
          since: { type: "number" },
          takeoverId: { type: "string" },
          reason: { type: "string" },
        },
        required: ["owner", "sessionIDs"],
        additionalProperties: false,
      },
    },
    forceTakeover: {
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
        },
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          interrupted: { type: "number" },
          takeoverId: { type: "string" },
        },
        required: ["interrupted"],
        additionalProperties: false,
      },
    },
  },
  events: {
    secretRequested: {
      schema: {
        type: "object",
        properties: {
          id: { type: "string" },
          sessionID: { type: "string" },
          name: { type: "string" },
          reason: { type: "string" },
        },
        required: ["id", "sessionID", "name", "reason"],
        additionalProperties: false,
      },
    },
    secretResolved: {
      schema: {
        type: "object",
        properties: {
          id: { type: "string" },
          sessionID: { type: "string" },
          outcome: { type: "string", enum: ["saved", "cancelled"] },
        },
        required: ["id", "sessionID", "outcome"],
        additionalProperties: false,
      },
    },
    takeoverRequested: {
      schema: {
        type: "object",
        properties: {
          id: { type: "string" },
          sessionID: { type: "string" },
          reason: { type: "string" },
          consoleUrl: { type: "string" },
        },
        required: ["id", "sessionID", "reason"],
        additionalProperties: false,
      },
    },
    takeoverResolved: {
      schema: {
        type: "object",
        properties: {
          id: { type: "string" },
          sessionID: { type: "string" },
          note: { type: "string" },
        },
        required: ["id", "sessionID"],
        additionalProperties: false,
      },
    },
  },
})
