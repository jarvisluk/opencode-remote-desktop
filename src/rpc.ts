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
          consoleUrls: { type: "array", items: { type: "string" } },
          activeTakeovers: { type: "number" },
          routineCount: { type: "number" },
        },
        required: [
          "platform",
          "supported",
          "accessibility",
          "screenRecording",
          "keepAwakeActive",
          "browserMode",
          "consoleUrls",
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
  },
  events: {
    takeoverRequested: {
      schema: {
        type: "object",
        properties: {
          id: { type: "string" },
          sessionID: { type: "string" },
          reason: { type: "string" },
          consoleUrls: { type: "array", items: { type: "string" } },
        },
        required: ["id", "sessionID", "reason", "consoleUrls"],
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
