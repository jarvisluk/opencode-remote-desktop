// bot-capture (macOS backend)
//
// Contract shared by every platform backend (see native/README.md):
//   stdout: binary frames  [u32 BE length][u64 BE pts µs][u8 flags (1 = keyframe)][H.264 Annex-B]
//   stdin:  JSON lines     {"t":"key"} {"t":"bitrate","v":bps} plus input events
//   stderr: JSON lines     {"t":"ready","width":W,"height":H} / {"t":"error","message":...}
// Pointer coordinates are normalized 0..1 over the captured display; keys use KeyboardEvent.code.
//
// Optional --snap-server mode (used by desktop.ts for fast in-memory JPEG capture):
//   stdin:  JSON lines     {"id":1,"screen":0,"maxDim":1440,"quality":72,"windowId":"...","app":"..."}
//   stdout: binary packet  [u32 BE id][u32 BE imgW][u32 BE imgH][i32 BE logX][i32 BE logY]
//                          [u32 BE logW][u32 BE logH][u32 BE payloadLen][u8 status (0=ok,1=err)][payload]

import AppKit
import CoreGraphics
import CoreMedia
import Foundation
import ImageIO
@preconcurrency import ScreenCaptureKit
import UniformTypeIdentifiers
import VideoToolbox

setvbuf(stderr, nil, _IONBF, 0)

func log(_ obj: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: obj) else { return }
  FileHandle.standardError.write(data + Data([0x0a]))
}

func fail(_ message: String) -> Never {
  log(["t": "error", "message": message])
  exit(1)
}

struct Options {
  var fps = 30
  var bitrate = 4_000_000
  var maxDim = 1920
  var display = 0
  var snapServer = false

  init(_ args: [String]) {
    var i = 1
    while i < args.count {
      if args[i] == "--snap-server" {
        snapServer = true
        i += 1
        continue
      }
      if i + 1 < args.count {
        let v = Int(args[i + 1]) ?? 0
        switch args[i] {
        case "--fps": fps = max(1, min(60, v))
        case "--bitrate": bitrate = max(200_000, v)
        case "--max-dim": maxDim = max(320, v)
        case "--display": display = max(0, v)
        default: break
        }
        i += 2
      } else {
        i += 1
      }
    }
  }
}

let options = Options(CommandLine.arguments)
let writeQueue = DispatchQueue(label: "bot.capture.write", qos: .userInteractive)
let stdoutHandle = FileHandle.standardOutput
let startCodes = Data([0, 0, 0, 1])

@inline(__always)
func writeBE32(_ buf: UnsafeMutableRawPointer, offset: Int, value: UInt32) {
  buf.storeBytes(of: value.bigEndian, toByteOffset: offset, as: UInt32.self)
}

@inline(__always)
func writeBE64(_ buf: UnsafeMutableRawPointer, offset: Int, value: UInt64) {
  buf.storeBytes(of: value.bigEndian, toByteOffset: offset, as: UInt64.self)
}

func writeFramedPacket(_ packet: Data) {
  writeQueue.async {
    do {
      try stdoutHandle.write(contentsOf: packet)
    } catch {
      exit(0) // reader went away
    }
  }
}

// MARK: - Encoder

final class Encoder: @unchecked Sendable {
  private var session: VTCompressionSession?
  private let lock = NSLock()
  private var forceKey = true
  private var lastBuffer: CVPixelBuffer?
  private var lastPts = CMTime.zero
  private let clockStart = CMClockGetTime(CMClockGetHostTimeClock())

  var hasFrame: Bool {
    lock.lock()
    defer { lock.unlock() }
    return lastBuffer != nil
  }

  init(width: Int, height: Int) {
    var s: VTCompressionSession?
    let spec: [CFString: Any] = [
      kVTVideoEncoderSpecification_EnableHardwareAcceleratedVideoEncoder: true,
      kVTVideoEncoderSpecification_EnableLowLatencyRateControl: true,
    ]
    let status = VTCompressionSessionCreate(
      allocator: nil, width: Int32(width), height: Int32(height), codecType: kCMVideoCodecType_H264,
      encoderSpecification: spec as CFDictionary,
      imageBufferAttributes: nil, compressedDataAllocator: nil, outputCallback: nil, refcon: nil,
      compressionSessionOut: &s)
    guard status == noErr, let s else { fail("VTCompressionSessionCreate failed: \(status)") }

    let props: [CFString: Any] = [
      kVTCompressionPropertyKey_RealTime: true,
      kVTCompressionPropertyKey_ProfileLevel: kVTProfileLevel_H264_ConstrainedBaseline_AutoLevel,
      kVTCompressionPropertyKey_AllowFrameReordering: false,
      kVTCompressionPropertyKey_MaxFrameDelayCount: 0,
      "PrioritizeEncodingSpeedOverQuality" as CFString: true,
      kVTCompressionPropertyKey_AverageBitRate: options.bitrate,
      kVTCompressionPropertyKey_DataRateLimits: Encoder.rateLimits(for: options.bitrate),
      kVTCompressionPropertyKey_ExpectedFrameRate: options.fps,
      kVTCompressionPropertyKey_MaxKeyFrameInterval: options.fps * 10,
      kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration: 10,
    ]
    for (k, v) in props { VTSessionSetProperty(s, key: k, value: v as CFTypeRef) }
    VTCompressionSessionPrepareToEncodeFrames(s)
    session = s
  }

  private static func rateLimits(for bps: Int) -> [NSNumber] {
    // Allow 1.5x peak over a 1-second window to prevent large IDR frames from bursting the RTP pacer.
    let bytesPerSec = max(50_000, (bps * 3) / 16)
    return [NSNumber(value: bytesPerSec), NSNumber(value: 1)]
  }

  func requestKeyframe() {
    lock.lock()
    forceKey = true
    let buffer = lastBuffer
    lock.unlock()
    // The screen may be static (ScreenCaptureKit sends no frames), so re-encode the last one.
    if let buffer { encode(buffer) }
  }

  func setBitrate(_ bps: Int) {
    guard let session else { return }
    let clamped = max(200_000, bps)
    VTSessionSetProperty(session, key: kVTCompressionPropertyKey_AverageBitRate, value: clamped as CFTypeRef)
    VTSessionSetProperty(session, key: kVTCompressionPropertyKey_DataRateLimits, value: Encoder.rateLimits(for: clamped) as CFTypeRef)
  }

  func encode(_ buffer: CVPixelBuffer) {
    guard let session else { return }
    lock.lock()
    lastBuffer = buffer
    let key = forceKey
    forceKey = false
    var pts = CMTimeSubtract(CMClockGetTime(CMClockGetHostTimeClock()), clockStart)
    if CMTimeCompare(pts, lastPts) <= 0 { pts = CMTimeAdd(lastPts, CMTime(value: 1, timescale: 1000)) }
    lastPts = pts
    lock.unlock()
    let frameProps = key ? [kVTEncodeFrameOptionKey_ForceKeyFrame: true] as CFDictionary : nil
    VTCompressionSessionEncodeFrame(
      session, imageBuffer: buffer, presentationTimeStamp: pts, duration: .invalid,
      frameProperties: frameProps, infoFlagsOut: nil
    ) { status, _, sample in
      guard status == noErr, let sample else { return }
      Encoder.emit(sample)
    }
  }

  private static func emit(_ sample: CMSampleBuffer) {
    guard let block = CMSampleBufferGetDataBuffer(sample) else { return }
    var keyframe = true
    if let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[CFString: Any]],
      let first = attachments.first, first[kCMSampleAttachmentKey_NotSync] as? Bool == true
    {
      keyframe = false
    }

    var length = 0
    var dataPtr: UnsafeMutablePointer<CChar>?
    guard CMBlockBufferGetDataPointer(block, atOffset: 0, lengthAtOffsetOut: nil, totalLengthOut: &length, dataPointerOut: &dataPtr) == noErr,
      let dataPtr
    else { return }

    // Reserve 13 bytes at the front for [u32 BE len][u64 BE pts µs][u8 keyframe] to avoid payload copies.
    var out = Data(count: 13)
    out.reserveCapacity(13 + length + 128)

    if keyframe, let format = CMSampleBufferGetFormatDescription(sample) {
      var count = 0
      CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
        format, parameterSetIndex: 0, parameterSetPointerOut: nil, parameterSetSizeOut: nil,
        parameterSetCountOut: &count, nalUnitHeaderLengthOut: nil)
      for i in 0..<count {
        var ptr: UnsafePointer<UInt8>?
        var size = 0
        CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
          format, parameterSetIndex: i, parameterSetPointerOut: &ptr, parameterSetSizeOut: &size,
          parameterSetCountOut: nil, nalUnitHeaderLengthOut: nil)
        if let ptr {
          out.append(startCodes)
          out.append(ptr, count: size)
        }
      }
    }

    // AVCC (4-byte length prefixes) -> Annex-B start codes
    let raw = UnsafeRawPointer(dataPtr)
    var offset = 0
    while offset + 4 <= length {
      let nalLen = Int(raw.loadUnaligned(fromByteOffset: offset, as: UInt32.self).bigEndian)
      offset += 4
      guard nalLen > 0, offset + nalLen <= length else { break }
      out.append(startCodes)
      out.append(raw.advanced(by: offset).assumingMemoryBound(to: UInt8.self), count: nalLen)
      offset += nalLen
    }

    let payloadLen = UInt32(out.count - 13)
    let pts = CMSampleBufferGetPresentationTimeStamp(sample)
    let micros = UInt64(max(0, CMTimeGetSeconds(pts) * 1_000_000))
    out.withUnsafeMutableBytes { ptr in
      guard let base = ptr.baseAddress else { return }
      writeBE32(base, offset: 0, value: payloadLen)
      writeBE64(base, offset: 4, value: micros)
      base.storeBytes(of: UInt8(keyframe ? 1 : 0), toByteOffset: 12, as: UInt8.self)
    }
    writeFramedPacket(out)
  }
}

// MARK: - Capture

final class Capture: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
  let encoder: Encoder
  init(encoder: Encoder) { self.encoder = encoder }

  func stream(_ stream: SCStream, didOutputSampleBuffer sample: CMSampleBuffer, of type: SCStreamOutputType) {
    guard type == .screen, sample.isValid,
      let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
      let raw = attachments.first?[.status] as? Int, SCFrameStatus(rawValue: raw) == .complete,
      let buffer = CMSampleBufferGetImageBuffer(sample)
    else { return }
    encoder.encode(buffer)
  }

  func stream(_ stream: SCStream, didStopWithError error: Error) {
    fail("capture stopped: \(error.localizedDescription)")
  }
}

// MARK: - Input

let keyCodes: [String: CGKeyCode] = [
  "KeyA": 0x00, "KeyS": 0x01, "KeyD": 0x02, "KeyF": 0x03, "KeyH": 0x04, "KeyG": 0x05, "KeyZ": 0x06, "KeyX": 0x07,
  "KeyC": 0x08, "KeyV": 0x09, "KeyB": 0x0B, "KeyQ": 0x0C, "KeyW": 0x0D, "KeyE": 0x0E, "KeyR": 0x0F, "KeyY": 0x10,
  "KeyT": 0x11, "Digit1": 0x12, "Digit2": 0x13, "Digit3": 0x14, "Digit4": 0x15, "Digit6": 0x16, "Digit5": 0x17,
  "Equal": 0x18, "Digit9": 0x19, "Digit7": 0x1A, "Minus": 0x1B, "Digit8": 0x1C, "Digit0": 0x1D,
  "BracketRight": 0x1E, "KeyO": 0x1F, "KeyU": 0x20, "BracketLeft": 0x21, "KeyI": 0x22, "KeyP": 0x23,
  "Enter": 0x24, "KeyL": 0x25, "KeyJ": 0x26, "Quote": 0x27, "KeyK": 0x28, "Semicolon": 0x29, "Backslash": 0x2A,
  "Comma": 0x2B, "Slash": 0x2C, "KeyN": 0x2D, "KeyM": 0x2E, "Period": 0x2F, "Tab": 0x30, "Space": 0x31,
  "Backquote": 0x32, "Backspace": 0x33, "Escape": 0x35, "MetaRight": 0x36, "MetaLeft": 0x37, "ShiftLeft": 0x38,
  "CapsLock": 0x39, "AltLeft": 0x3A, "ControlLeft": 0x3B, "ShiftRight": 0x3C, "AltRight": 0x3D,
  "ControlRight": 0x3E, "NumpadDecimal": 0x41, "NumpadMultiply": 0x43, "NumpadAdd": 0x45, "NumLock": 0x47,
  "NumpadDivide": 0x4B, "NumpadEnter": 0x4C, "NumpadSubtract": 0x4E, "NumpadEqual": 0x51, "Numpad0": 0x52,
  "Numpad1": 0x53, "Numpad2": 0x54, "Numpad3": 0x55, "Numpad4": 0x56, "Numpad5": 0x57, "Numpad6": 0x58,
  "Numpad7": 0x59, "Numpad8": 0x5B, "Numpad9": 0x5C, "F5": 0x60, "F6": 0x61, "F7": 0x62, "F3": 0x63, "F8": 0x64,
  "F9": 0x65, "F11": 0x67, "F10": 0x6D, "F12": 0x6F, "Insert": 0x72, "Home": 0x73, "PageUp": 0x74,
  "Delete": 0x75, "F4": 0x76, "End": 0x77, "F2": 0x78, "PageDown": 0x79, "F1": 0x7A, "ArrowLeft": 0x7B,
  "ArrowRight": 0x7C, "ArrowDown": 0x7D, "ArrowUp": 0x7E,
]

final class Input: @unchecked Sendable {
  let bounds: CGRect
  private var buttonsDown = Set<Int>()
  private var lastDown = (time: 0.0, point: CGPoint.zero, button: -1, count: 0)

  init(displayID: CGDirectDisplayID) { bounds = CGDisplayBounds(displayID) }

  private func point(_ msg: [String: Any]) -> CGPoint {
    let x = min(1, max(0, msg["x"] as? Double ?? 0))
    let y = min(1, max(0, msg["y"] as? Double ?? 0))
    return CGPoint(x: bounds.minX + x * bounds.width, y: bounds.minY + y * bounds.height)
  }

  private func flags(_ msg: [String: Any]) -> CGEventFlags {
    var f: CGEventFlags = []
    if msg["shift"] as? Bool == true { f.insert(.maskShift) }
    if msg["ctrl"] as? Bool == true { f.insert(.maskControl) }
    if msg["alt"] as? Bool == true { f.insert(.maskAlternate) }
    if msg["meta"] as? Bool == true { f.insert(.maskCommand) }
    return f
  }

  func handle(_ msg: [String: Any]) {
    switch msg["t"] as? String {
    case "move": mouse(msg, phase: "move")
    case "down": mouse(msg, phase: "down")
    case "up": mouse(msg, phase: "up")
    case "wheel":
      let dy = Int32(max(-2000, min(2000, msg["dy"] as? Double ?? 0)))
      let dx = Int32(max(-2000, min(2000, msg["dx"] as? Double ?? 0)))
      CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: -dy, wheel2: -dx, wheel3: 0)?
        .post(tap: .cghidEventTap)
    case "keydown", "keyup":
      guard let code = msg["code"] as? String, let vk = keyCodes[code] else { return }
      let event = CGEvent(keyboardEventSource: nil, virtualKey: vk, keyDown: msg["t"] as? String == "keydown")
      event?.flags = flags(msg)
      event?.post(tap: .cghidEventTap)
    case "text":
      guard let text = msg["s"] as? String, !text.isEmpty else { return }
      let units = Array(text.prefix(2000).utf16)
      var i = 0
      while i < units.count {
        let chunk = Array(units[i..<min(i + 16, units.count)])
        for down in [true, false] {
          let event = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: down)
          event?.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: chunk)
          event?.post(tap: .cghidEventTap)
        }
        i += 16
      }
    default: break
    }
  }

  private func mouse(_ msg: [String: Any], phase: String) {
    let p = point(msg)
    let button = max(0, min(2, msg["b"] as? Int ?? 0))
    let cgButton: CGMouseButton = button == 2 ? .right : button == 1 ? .center : .left
    var type: CGEventType
    switch phase {
    case "down":
      buttonsDown.insert(button)
      type = button == 2 ? .rightMouseDown : button == 1 ? .otherMouseDown : .leftMouseDown
      let now = ProcessInfo.processInfo.systemUptime
      let near = abs(p.x - lastDown.point.x) < 5 && abs(p.y - lastDown.point.y) < 5
      let count = (now - lastDown.time < 0.45 && near && lastDown.button == button) ? lastDown.count + 1 : 1
      lastDown = (now, p, button, count)
    case "up":
      buttonsDown.remove(button)
      type = button == 2 ? .rightMouseUp : button == 1 ? .otherMouseUp : .leftMouseUp
    default:
      if buttonsDown.contains(0) { type = .leftMouseDragged }
      else if buttonsDown.contains(2) { type = .rightMouseDragged }
      else if buttonsDown.contains(1) { type = .otherMouseDragged }
      else { type = .mouseMoved }
    }
    guard let event = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: p, mouseButton: cgButton)
    else { return }
    if phase != "move" { event.setIntegerValueField(.mouseEventClickState, value: Int64(lastDown.count)) }
    event.flags = flags(msg)
    event.post(tap: .cghidEventTap)
  }
}

// MARK: - Fast In-Memory JPEG Snapshot Server (--snap-server)

@available(macOS 14.0, *)
final class SnapServer: @unchecked Sendable {
  private var cachedContent: SCShareableContent?
  private var cachedAt: CFAbsoluteTime = 0

  private func shareableContent(forceRefresh: Bool = false) async throws -> SCShareableContent {
    let now = CFAbsoluteTimeGetCurrent()
    if !forceRefresh, let c = cachedContent, now - cachedAt < 2.0 {
      return c
    }
    let c = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
    cachedContent = c
    cachedAt = now
    return c
  }

  func capture(_ req: [String: Any]) async throws -> (jpeg: Data, imgW: Int, imgH: Int, bounds: CGRect) {
    let maxDim = max(320, min(3840, req["maxDim"] as? Int ?? 1440))
    let quality = Double(max(20, min(95, req["quality"] as? Int ?? 72))) / 100.0
    let screenIdx = max(0, req["screen"] as? Int ?? 0)
    let windowIdStr = req["windowId"] as? String
    let appName = req["app"] as? String

    var content = try await shareableContent()
    let filter: SCContentFilter
    let bounds: CGRect

    if (windowIdStr != nil && !windowIdStr!.isEmpty) || (appName != nil && !appName!.isEmpty) {
      let findWindow: (SCShareableContent) -> SCWindow? = { c in
        if let wid = windowIdStr, !wid.isEmpty {
          let numeric = UInt32(wid.replacingOccurrences(of: "w-", with: ""))
          return c.windows.first { w in
            String(w.windowID) == wid || (numeric != nil && w.windowID == numeric!)
          }
        }
        if let app = appName, !app.isEmpty {
          return c.windows.first { w in
            w.owningApplication?.applicationName.localizedCaseInsensitiveCompare(app) == .orderedSame && w.isOnScreen
          }
        }
        return nil
      }
      var matched = findWindow(content)
      if matched == nil {
        content = try await shareableContent(forceRefresh: true)
        matched = findWindow(content)
      }
      guard let win = matched else {
        throw NSError(domain: "bot.snap", code: 404, userInfo: [NSLocalizedDescriptionKey: "Window not found"])
      }
      filter = SCContentFilter(desktopIndependentWindow: win)
      bounds = win.frame
    } else {
      guard !content.displays.isEmpty else {
        throw NSError(domain: "bot.snap", code: 404, userInfo: [NSLocalizedDescriptionKey: "No displays"])
      }
      let disp = content.displays[min(screenIdx, content.displays.count - 1)]
      filter = SCContentFilter(display: disp, excludingWindows: [])
      bounds = disp.frame
    }

    let scale = min(1.0, Double(maxDim) / Double(max(1.0, max(bounds.width, bounds.height))))
    let outW = max(2, Int(bounds.width * scale) & ~1)
    let outH = max(2, Int(bounds.height * scale) & ~1)

    let cfg = SCStreamConfiguration()
    cfg.width = outW
    cfg.height = outH
    cfg.showsCursor = true

    let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: cfg)
    let jpegData = NSMutableData()
    guard let dest = CGImageDestinationCreateWithData(jpegData, UTType.jpeg.identifier as CFString, 1, nil) else {
      throw NSError(domain: "bot.snap", code: 500, userInfo: [NSLocalizedDescriptionKey: "CGImageDestination failed"])
    }
    CGImageDestinationAddImage(dest, image, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
    guard CGImageDestinationFinalize(dest) else {
      throw NSError(domain: "bot.snap", code: 500, userInfo: [NSLocalizedDescriptionKey: "JPEG encode failed"])
    }
    return (jpegData as Data, image.width, image.height, bounds)
  }

  func listWindows(_ req: [String: Any]) throws -> Data {
    let appFilter = (req["app"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    let frontPid = NSWorkspace.shared.frontmostApplication?.processIdentifier
    let raw = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
    var out: [[String: Any]] = []
    var seenFocused = false
    for w in raw {
      guard let layer = w[kCGWindowLayer as String] as? Int, layer == 0,
            let wid = w[kCGWindowNumber as String] as? Int,
            let bounds = w[kCGWindowBounds as String] as? [String: Any],
            let width = bounds["Width"] as? Double, width >= 80,
            let height = bounds["Height"] as? Double, height >= 60 else { continue }
      let owner = (w[kCGWindowOwnerName as String] as? String) ?? ""
      if owner.isEmpty || owner == "Window Server" || owner == "WindowManager" || owner == "Dock" { continue }
      if !appFilter.isEmpty && owner.localizedCaseInsensitiveCompare(appFilter) != .orderedSame { continue }
      let title = (w[kCGWindowName as String] as? String) ?? ""
      let pid = w[kCGWindowOwnerPID as String] as? Int32
      let isFocused = !seenFocused && pid != nil && pid == frontPid
      if isFocused { seenFocused = true }
      out.append([
        "id": "w-\(wid)",
        "app_name": owner,
        "title": title.isEmpty ? owner : title,
        "is_focused": isFocused,
        "visible": true,
        "accessible": true,
        "bounds": [
          "x": (bounds["X"] as? Double) ?? 0.0,
          "y": (bounds["Y"] as? Double) ?? 0.0,
          "width": width,
          "height": height,
        ],
      ])
    }
    return try JSONSerialization.data(withJSONObject: out)
  }

  func sendReply(id: UInt32, status: UInt8, imgW: Int, imgH: Int, bounds: CGRect, payload: Data) {
    // Header: 33 bytes = [u32 id][u32 imgW][u32 imgH][i32 logX][i32 logY][u32 logW][u32 logH][u32 len][u8 status]
    var packet = Data(count: 33)
    packet.withUnsafeMutableBytes { ptr in
      guard let b = ptr.baseAddress else { return }
      writeBE32(b, offset: 0, value: id)
      writeBE32(b, offset: 4, value: UInt32(max(0, imgW)))
      writeBE32(b, offset: 8, value: UInt32(max(0, imgH)))
      writeBE32(b, offset: 12, value: UInt32(bitPattern: Int32(bounds.minX.rounded())))
      writeBE32(b, offset: 16, value: UInt32(bitPattern: Int32(bounds.minY.rounded())))
      writeBE32(b, offset: 20, value: UInt32(max(0, Int(bounds.width.rounded()))))
      writeBE32(b, offset: 24, value: UInt32(max(0, Int(bounds.height.rounded()))))
      writeBE32(b, offset: 28, value: UInt32(payload.count))
      b.storeBytes(of: status, toByteOffset: 32, as: UInt8.self)
    }
    packet.append(payload)
    writeFramedPacket(packet)
  }
}

func runSnapServer() {
  guard #available(macOS 14.0, *) else {
    fail("--snap-server requires macOS 14.0 or newer")
  }
  let server = SnapServer()
  log(["t": "snap-ready"])
  Thread.detachNewThread {
    let sem = DispatchSemaphore(value: 0)
    while let line = readLine(strippingNewline: true) {
      guard let data = line.data(using: .utf8),
        let req = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
        let reqId = req["id"] as? UInt32 ?? (req["id"] as? Int).map({ UInt32(max(0, $0)) })
      else { continue }
      if (req["cmd"] as? String) == "list-windows" {
        do {
          let json = try server.listWindows(req)
          server.sendReply(id: reqId, status: 0, imgW: 0, imgH: 0, bounds: .zero, payload: json)
        } catch {
          let errData = error.localizedDescription.data(using: .utf8) ?? Data()
          server.sendReply(id: reqId, status: 1, imgW: 0, imgH: 0, bounds: .zero, payload: errData)
        }
        continue
      }
      Task {
        do {
          let res = try await server.capture(req)
          server.sendReply(id: reqId, status: 0, imgW: res.imgW, imgH: res.imgH, bounds: res.bounds, payload: res.jpeg)
        } catch {
          let errData = error.localizedDescription.data(using: .utf8) ?? Data()
          server.sendReply(id: reqId, status: 1, imgW: 0, imgH: 0, bounds: .zero, payload: errData)
        }
        sem.signal()
      }
      sem.wait()
    }
    exit(0)
  }
  dispatchMain()
}

// MARK: - Main

signal(SIGPIPE, SIG_IGN)

if options.snapServer {
  runSnapServer()
}

Task {
  let content: SCShareableContent
  do {
    content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
  } catch {
    fail("screen recording permission missing or denied: \(error.localizedDescription)")
  }
  guard !content.displays.isEmpty else { fail("no displays") }
  let display = content.displays[min(options.display, content.displays.count - 1)]
  let scale = min(1.0, Double(options.maxDim) / Double(max(display.width, display.height)))
  // Even dimensions keep the H.264 encoder happy.
  let width = Int(Double(display.width) * scale) & ~1
  let height = Int(Double(display.height) * scale) & ~1

  let config = SCStreamConfiguration()
  config.width = width
  config.height = height
  config.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(options.fps))
  config.pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
  config.showsCursor = true
  config.queueDepth = 3

  let filter = SCContentFilter(display: display, excludingWindows: [])
  let encoder = Encoder(width: width, height: height)
  let capture = Capture(encoder: encoder)
  let input = Input(displayID: display.displayID)
  let stream = SCStream(filter: filter, configuration: config, delegate: capture)
  do {
    try stream.addStreamOutput(capture, type: .screen, sampleHandlerQueue: DispatchQueue(label: "bot.capture.frames", qos: .userInteractive))
    try await stream.startCapture()
  } catch {
    fail("start capture failed: \(error.localizedDescription)")
  }
  log(["t": "ready", "width": width, "height": height, "displayWidth": display.width, "displayHeight": display.height])

  Thread.detachNewThread {
    _ = capture // keep alive
    _ = stream
    while let line = readLine(strippingNewline: true) {
      guard let data = line.data(using: .utf8),
        let msg = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
      else { continue }
      switch msg["t"] as? String {
      case "key": encoder.requestKeyframe()
      case "bitrate": if let v = msg["v"] as? Int { encoder.setBitrate(v) }
      default: input.handle(msg)
      }
    }
    exit(0) // stdin closed: parent is gone
  }
}

dispatchMain()
