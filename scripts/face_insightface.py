import cv2
import sys
import json
import os
import time
import base64
import numpy as np

CASCADE_PATH = cv2.data.haarcascades + 'haarcascade_eye.xml'
eye_cascade = cv2.CascadeClassifier(CASCADE_PATH)

_app = None

def get_app():
    global _app
    if _app is None:
        old_stdout = sys.stdout
        sys.stdout = open(os.devnull, 'w')
        try:
            from insightface.app import FaceAnalysis
            _app = FaceAnalysis(name='buffalo_l', providers=['CPUExecutionProvider'])
            _app.prepare(ctx_id=0, det_size=(640, 640))
        finally:
            sys.stdout.close()
            sys.stdout = old_stdout
    return _app

def cosine_similarity(a, b):
    a = np.array(a, dtype=np.float32)
    b = np.array(b, dtype=np.float32)
    norm_a = np.linalg.norm(a)
    norm_b = np.linalg.norm(b)
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return float(np.dot(a, b) / (norm_a * norm_b))

def analyze_face(image_path):
    t0 = time.time()
    img = cv2.imread(image_path)
    if img is None:
        try:
            from PIL import Image
            import pillow_heif
            pillow_heif.register_heif_opener()
            pil_img = Image.open(image_path)
            # Convert to RGB preserving quality
            if pil_img.mode in ('RGBA', 'LA', 'PA'):
                pil_img = pil_img.convert('RGB')
            elif pil_img.mode != 'RGB':
                pil_img = pil_img.convert('RGB')
            import numpy as np
            img = cv2.cvtColor(np.array(pil_img), cv2.COLOR_RGB2BGR)
        except Exception:
            return {"success": False, "error": "Cannot read image"}

    h_img, w_img = img.shape[:2]
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)

    app = get_app()
    faces_data = app.get(img)

    results = []
    for i, face in enumerate(faces_data):
        x, y, w, h = face.bbox.astype(int)
        x = max(0, x)
        y = max(0, y)
        w = min(w, w_img)
        h = min(h, h_img)
        fw = w - x
        fh = h - y

        if fw < 20 or fh < 20:
            continue

        embedding = face.embedding.tolist() if face.embedding is not None else None
        det_score = float(face.det_score) if face.det_score is not None else 0.5

        gender = 'male' if face.gender == 1 else 'female' if face.gender == 0 else 'unknown'
        age = int(face.age) if face.age is not None else 30

        if age > 25: age_group = 'adult'
        elif age > 18: age_group = 'young_adult'
        elif age > 12: age_group = 'teen'
        else: age_group = 'child'

        kps = face.kps.tolist() if face.kps is not None else []

        face_img = img[y:h, x:w]
        face_gray = gray[y:h, x:w]

        small = cv2.resize(face_gray, (9, 8))
        diff = small[:, 1:] > small[:, :-1]
        phash = int(sum(2**j for j, v in enumerate(diff.flatten()) if v))

        resized = cv2.resize(face_gray, (9, 9))
        dhash = int(sum(2**j for j, v in enumerate((resized[:, 1:] > resized[:, :-1]).flatten()) if v))

        thumb = cv2.resize(face_img, (128, 128))
        _, thumb_buf = cv2.imencode('.jpg', thumb, [cv2.IMWRITE_JPEG_QUALITY, 85])
        thumb_b64 = base64.b64encode(thumb_buf).decode()

        eyes = eye_cascade.detectMultiScale(face_gray, 1.1, 3)
        has_glasses = len(eyes) == 0 and fw > 80

        confidence = min(1.0, round(max(0.4, det_score), 2))

        results.append({
            "index": i,
            "confidence": confidence,
            "bbox": {"x": int(x), "y": int(y), "width": int(fw), "height": int(fh)},
            "gender": gender,
            "gender_confidence": round(det_score, 2),
            "age_group": age_group,
            "age_approx": age,
            "expression": "neutral",
            "expression_confidence": 0.5,
            "has_glasses": bool(has_glasses),
            "perceptual_hash": phash,
            "dhash": dhash,
            "face_descriptor": {
                "phash": phash,
                "dhash": dhash,
                "embedding": embedding,
                "landmarks": kps,
                "det_score": round(det_score, 4)
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
        print(json.dumps({"error": "Usage: python face_insightface.py <image_path>"}))
        sys.exit(1)
    result = analyze_face(sys.argv[1])
    print(json.dumps(result))
