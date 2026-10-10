import Foundation
import Vision
import ImageIO
import CoreGraphics

var ocrTargets: [String: CGRect] = [:]
func recognizeScreenText(_ command: [String: Any]) throws -> [[String: Any]] {
    guard let encoded = command["image"] as? String, let data = Data(base64Encoded: encoded),
          let source = CGImageSourceCreateWithData(data as CFData, nil), let image = CGImageSourceCreateImageAtIndex(source, 0, nil),
          let x = command["x"] as? Double, let y = command["y"] as? Double,
          let width = command["width"] as? Double, let height = command["height"] as? Double else { throw BridgeFailure.unavailable }
    let request = VNRecognizeTextRequest(); request.recognitionLevel = .accurate; request.usesLanguageCorrection = false
    try VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
    ocrTargets.removeAll(); var nodes: [[String: Any]] = []
    for observation in (request.results ?? []).prefix(200) {
        guard let candidate = observation.topCandidates(1).first, candidate.confidence >= 0.3 else { continue }
        let b = observation.boundingBox
        let rect = CGRect(x: x + b.minX * width, y: y + (1 - b.maxY) * height, width: b.width * width, height: b.height * height)
        let id = "ocr\(nodes.count + 1)"; ocrTargets[id] = rect
        nodes.append(["id": id, "name": String(candidate.string.prefix(512)), "role": "ScreenText", "source": "ocr", "confidence": candidate.confidence,
                      "x": rect.minX, "y": rect.minY, "width": rect.width, "height": rect.height,
                      "enabled": true, "focused": false, "password": false, "canInvoke": false, "canFill": false])
    }
    return nodes
}
