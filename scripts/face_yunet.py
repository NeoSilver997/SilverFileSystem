import cv2
import sys
import json
import os
import time
import base64
import numpy as np

YUNET_MODEL_PATH = os.path.join(os.path.dirname(__file__), '..', 'models', 'yunet_face.onnx')
CASCADE_PATH = cv2.data.haarcascades + 'haarcascade_eye.xml'
eye_cascade = cv2.CascadeClassifier(CASCADE_PATH)

session = None

def get_session():
    global session
    if session is None:
        import onnxruntime as ort
        session = ort.InferenceSession(YUNET_MODEL_PATH, providers=['CPUExecutionProvider'])
    return session

def nms(boxes, scores, threshold=0.5):
    x1 = boxes[:, 0]
    y1 = boxes[:, 1]
    x2 = boxes[:, 0] + boxes[:, 2]
    y2 = boxes[:, 1] + boxes[:, 3]
    areas = boxes[:, 2] * boxes[:, 3]
    order = scores.argsort()[::-1]
    keep = []
    while len(order) > 0:
        i = order[0]
        keep.append(i)
        xx1 = np.maximum(x1[i], x1[order[1:]])
        yy1 = np.maximum(y1[i], y1[order[1:]])
        xx2 = np.minimum(x2[i], x2[order[1:]])
        yy2 = np.minimum(y2[i], y2[order[1:]])
        w = np.maximum(0, xx2 - xx1)
        h = np.maximum(0, yy2 - yy1)
        inter = w * h
        iou = inter / (areas[i] + areas[order[1:]] - inter)
        inds = np.where(iou <= threshold)[0]
        order = order[inds + 1]
    return keep

def postprocess(outputs, img_w, img_h):
    cls_8, cls_16, cls_32 = outputs[0], outputs[1], outputs[2]
    obj_8, obj_16, obj_32 = outputs[3], outputs[4], outputs[5]
    bbox_8, bbox_16, bbox_32 = outputs[6], outputs[7], outputs[8]
    kps_8, kps_16, kps_32 = outputs[9], outputs[10], outputs[11]

    scores = np.concatenate([
        cls_8[0, :, 0] * obj_8[0, :, 0],
        cls_16[0, :, 0] * obj_16[0, :, 0],
        cls_32[0, :, 0] * obj_32[0, :, 0]
    ])

    bboxes = np.concatenate([bbox_8[0], bbox_16[0], bbox_32[0]], axis=0)
    kps_all = np.concatenate([kps_8[0], kps_16[0], kps_32[0]], axis=0)

    mask = scores > 0.5
    scores = scores[mask]
    bboxes = bboxes[mask]
    kps_all = kps_all[mask]

    if len(scores) == 0:
        return []

    keep = nms(bboxes, scores, 0.5)
    results = []
    for i in keep:
        cx, cy, w, h = bboxes[i]
        x = int((cx - w / 2) * img_w)
        y = int((cy - h / 2) * img_h)
        fw = int(w * img_w)
        fh = int(h * img_h)

        kps = kps_all[i].reshape(5, 2)
        kps[:, 0] *= img_w
        kps[:, 1] *= img_h

        results.append({
            'bbox': (x, y, fw, fh),
            'score': float(scores[i]),
            'kps': kps.tolist()
        })

    return results

def align_face(img, kps, target_size=128):
    left_eye = np.array(kps[0])
    right_eye = np.array(kps[1])
    mouth_left = np.array(kps[3])
    mouth_right = np.array(kps[4])

    eye_center = (left_eye + right_eye) / 2
    dy = right_eye[1] - left_eye[1]
    dx = right_eye[0] - left_eye[0]
    angle = np.degrees(np.arctan2(dy, dx))

    eye_dist = np.sqrt(dx**2 + dy**2)
    desired_left = np.array([target_size * 0.35, target_size * 0.35])
    desired_right = np.array([target_size * 0.65, target_size * 0.35])
    desired_dist = np.sqrt((desired_right[0] - desired_left[0])**2 + (desired_right[1] - desired_left[1])**2)

    scale = desired_dist / (eye_dist + 1e-6)

    M = cv2.getRotationMatrix2D((eye_center[0], eye_center[1]), angle, scale)
    M[0, 2] += target_size / 2 - eye_center[0]
    M[1, 2] += target_size / 2 - eye_center[1]

    aligned = cv2.warpAffine(img, M, (target_size, target_size), flags=cv2.INTER_LINEAR)
    return aligned

def compute_phash(gray, hash_size=8):
    small = cv2.resize(gray, (hash_size * 4, hash_size * 4))
    float_img = np.float32(small)
    dct = cv2.dct(float_img)
    dct_low = dct[:hash_size, :hash_size]
    mean_val = dct_low.mean()
    bits = (dct_low > mean_val).flatten()
    return int(sum(2**i for i, v in enumerate(bits) if v))

def compute_dhash(gray, hash_size=8):
    resized = cv2.resize(gray, (hash_size + 1, hash_size))
    diff = resized[:, 1:] > resized[:, :-1]
    return int(sum(2**i for i, v in enumerate(diff.flatten()) if v))

def analyze_face(image_path):
    t0 = time.time()
    img = cv2.imread(image_path)
    if img is None:
        return {"success": False, "error": "Cannot read image"}

    h_img, w_img = img.shape[:2]
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    gray = cv2.equalizeHist(gray)

    target_size = 640
    scale = min(target_size / w_img, target_size / h_img)
    if scale < 1.0:
        resized = cv2.resize(img, (int(w_img * scale), int(h_img * scale)))
    else:
        resized = img.copy()
        scale = 1.0

    rh, rw = resized.shape[:2]
    blob = cv2.dnn.blobFromImage(resized, 1.0 / 255.0, (rw, rh), (0, 0, 0), swapRB=True, crop=False)

    sess = get_session()
    outputs = sess.run(None, {'input': blob})
    detections = postprocess(outputs, rw, rh)

    results = []
    for i, det in enumerate(detections):
        x, y, fw, fh = det['bbox']
        x = int(x / scale)
        y = int(y / scale)
        fw = int(fw / scale)
        fh = int(fh / scale)
        score = det['score']
        kps = [[kp[0] / scale, kp[1] / scale] for kp in det['kps']]

        x = max(0, x)
        y = max(0, y)
        fw = min(fw, w_img - x)
        fh = min(fh, h_img - y)

        if fw < 20 or fh < 20:
            continue

        face_img = img[y:y+fh, x:x+fw]
        face_gray = gray[y:y+fh, x:x+fw]

        aligned = align_face(img, kps, 128)
        aligned_gray = cv2.cvtColor(aligned, cv2.COLOR_BGR2GRAY)

        phash = compute_phash(aligned_gray)
        dhash = compute_dhash(aligned_gray)

        thumb = cv2.resize(face_img, (128, 128))
        _, thumb_buf = cv2.imencode('.jpg', thumb, [cv2.IMWRITE_JPEG_QUALITY, 85])
        thumb_b64 = base64.b64encode(thumb_buf).decode()

        rel_size = (fw * fh) / (w_img * h_img)
        confidence = min(1.0, round(max(0.4, 0.3 + rel_size * 5 + score * 0.3), 2))

        eyes = eye_cascade.detectMultiScale(face_gray, 1.1, 3)
        has_glasses = len(eyes) == 0 and fw > 80

        aspect = fw / fh if fh > 0 else 1.0
        lower_half = face_gray[fh // 2:, :]
        lower_width = cv2.countNonZero(cv2.threshold(lower_half, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)[1])
        upper_half = face_gray[:fh // 2, :]
        upper_width = cv2.countNonZero(cv2.threshold(upper_half, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)[1])
        jaw_ratio = lower_width / (upper_width + 1)
        blur = cv2.Laplacian(face_gray, cv2.CV_64F).var()

        if jaw_ratio > 1.1 and blur < 500:
            gender = 'male'
            gender_conf = 0.6
        elif jaw_ratio < 0.9 or blur > 800:
            gender = 'female'
            gender_conf = 0.6
        else:
            gender = 'unknown'
            gender_conf = 0.4

        if rel_size > 0.15:
            age_group, age_approx = 'adult', 30
        elif rel_size > 0.08:
            age_group, age_approx = 'young_adult', 22
        elif rel_size > 0.04:
            age_group, age_approx = 'teen', 15
        else:
            age_group, age_approx = 'child', 8

        results.append({
            "index": i,
            "confidence": confidence,
            "bbox": {"x": int(x), "y": int(y), "width": int(fw), "height": int(fh)},
            "gender": gender,
            "gender_confidence": round(gender_conf, 2),
            "age_group": age_group,
            "age_approx": age_approx,
            "expression": "neutral",
            "expression_confidence": 0.5,
            "has_glasses": bool(has_glasses),
            "perceptual_hash": phash,
            "dhash": dhash,
            "face_descriptor": {
                "phash": phash,
                "dhash": dhash,
                "landmarks": kps,
                "yunet_score": round(score, 4)
            },
            "thumbnail": thumb_b64
        })

    elapsed = round((time.time() - t0) * 1000)

    return {
        "success": True,
        "faces": results,
        "elapsed": elapsed,
        "filePath": image_path,
        "summary": {
            "faceCount": len(results),
            "hasFaces": len(results) > 0,
            "maleCount": sum(1 for f in results if f["gender"] == "male"),
            "femaleCount": sum(1 for f in results if f["gender"] == "female"),
            "childCount": sum(1 for f in results if f["age_group"] == "child"),
            "averageConfidence": round(sum(f["confidence"] for f in results) / len(results), 2) if results else None
        }
    }

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: python face_yunet.py <image_path>"}))
        sys.exit(1)
    result = analyze_face(sys.argv[1])
    print(json.dumps(result))
