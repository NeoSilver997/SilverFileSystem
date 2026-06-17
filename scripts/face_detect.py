import cv2
import sys
import json
import os
import time
import hashlib
import struct

CASCADE_PATH = cv2.data.haarcascades + 'haarcascade_frontalface_default.xml'
EYE_CASCADE_PATH = cv2.data.haarcascades + 'haarcascade_eye.xml'
face_cascade = cv2.CascadeClassifier(CASCADE_PATH)
eye_cascade = cv2.CascadeClassifier(EYE_CASCADE_PATH)

def dhash(img, hash_size=8):
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY) if len(img.shape) == 3 else img
    resized = cv2.resize(gray, (hash_size + 1, hash_size))
    diff = resized[:, 1:] > resized[:, :-1]
    return sum(2 ** i for i, v in enumerate(diff.flatten()) if v)

def phash(img, hash_size=8):
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY) if len(img.shape) == 3 else img
    resized = cv2.resize(gray, (hash_size * 4, hash_size * 4))
    float_img = np.float32(resized)
    dct = cv2.dct(float_img)
    dct_low = dct[:hash_size, :hash_size]
    mean_val = dct_low.mean()
    bits = (dct_low > mean_val).flatten()
    return sum(2 ** i for i, v in enumerate(bits) if v)

def hamming_distance(h1, h2):
    return bin(h1 ^ h2).count('1')

def detect_faces(image_path):
    t0 = time.time()
    img = cv2.imread(image_path)
    if img is None:
        return {"success": False, "error": "Cannot read image"}

    h, w = img.shape[:2]
    grey = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    grey = cv2.equalizeHist(grey)

    faces_raw = face_cascade.detectMultiScale(
        grey, scaleFactor=1.08, minNeighbors=6, minSize=(40, 40),
        flags=cv2.CASCADE_SCALE_IMAGE
    )

    faces = []
    img_area = w * h

    for (x, y, fw, fh) in faces_raw:
        face_area = fw * fh
        rel_size = face_area / img_area
        if rel_size < 0.001 or rel_size > 0.5:
            continue
        if fw < 40 or fh < 40:
            continue
        ar = fw / fh
        if ar < 0.3 or ar > 3.0:
            continue

        pad_x = int(fw * 0.25)
        pad_y = int(fh * 0.3)
        x1 = max(0, x - pad_x)
        y1 = max(0, y - pad_y)
        x2 = min(w, x + fw + pad_x)
        y2 = min(h, y + fh + pad_y)

        face_crop = img[y:y+fh, x:x+fw]
        face_resized = cv2.resize(face_crop, (128, 128))

        _, thumb_buf = cv2.imencode('.jpg', face_resized, [cv2.IMWRITE_JPEG_QUALITY, 85])
        thumb_b64 = __import__('base64').b64encode(thumb_buf).decode()

        hval = dhash(face_resized)

        roi_grey = grey[y:y+fh, x:x+fw]
        eyes = eye_cascade.detectMultiScale(roi_grey, 1.1, 3)
        has_glasses = len(eyes) == 0 and fw > 80

        mean_bgr = cv2.mean(face_crop)[:3]
        skin_score = 0
        if mean_bgr[2] > mean_bgr[0] and mean_bgr[2] > mean_bgr[1]:
            skin_score = min(1.0, (mean_bgr[2] - mean_bgr[1]) / 50.0)

        rel_y = (y + fh/2) / h
        size_ratio = fw / w

        conf = min(1.0, round(max(0.4, 0.3 + rel_size * 5 + skin_score * 0.3), 2))

        faces.append({
            "index": len(faces),
            "confidence": conf,
            "bbox": {"x": int(x1), "y": int(y1), "width": int(x2-x1), "height": int(y2-y1)},
            "face_bbox": {"x": int(x), "y": int(y), "width": int(fw), "height": int(fh)},
            "thumbnail": thumb_b64,
            "perceptual_hash": hval,
            "has_glasses": bool(has_glasses),
            "skin_tone": round(skin_score, 2),
            "relative_position": {"x": round((x + fw/2) / w, 3), "y": round(rel_y, 3)},
            "relative_size": round(size_ratio, 3),
            "gender": None,
            "age_group": None,
            "expression": None
        })

    faces.sort(key=lambda f: f["confidence"], reverse=True)
    for i, f in enumerate(faces):
        f["index"] = i

    elapsed = round((time.time() - t0) * 1000)

    return {
        "success": True,
        "faces": faces,
        "elapsed": elapsed,
        "filePath": image_path,
        "imageSize": {"width": w, "height": h},
        "summary": {
            "faceCount": len(faces),
            "hasFaces": len(faces) > 0,
            "averageConfidence": round(sum(f["confidence"] for f in faces) / len(faces), 2) if faces else None
        }
    }

if __name__ == "__main__":
    import numpy as np
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: python face_detect.py <image_path>"}))
        sys.exit(1)
    path = sys.argv[1]
    if not os.path.exists(path):
        print(json.dumps({"error": f"File not found: {path}"}))
        sys.exit(1)
    result = detect_faces(path)
    print(json.dumps(result))
