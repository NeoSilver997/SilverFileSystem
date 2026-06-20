import cv2
import sys
import json
import os
import time
import base64
import numpy as np

CASCADE_PATH = cv2.data.haarcascades + 'haarcascade_eye.xml'
eye_cascade = cv2.CascadeClassifier(CASCADE_PATH)

_apps = {}

MODEL_CHAIN = [
    'buffalo_l',       # Primary: ResNet50@WebFace600K (326MB)
    'antelopev2',      # Fallback: ResNet100@Glint360K (407MB)
    'buffalo_m',       # Fallback: ResNet50@WebFace600K (312MB)
    'buffalo_s',       # Fallback: MobileFaceNet@WebFace600K (158MB)
    'buffalo_sc',      # Last resort: MobileFaceNet compact (15MB)
]

def get_app(model_name=None):
    if model_name and model_name in _apps:
        return _apps[model_name], model_name

    if model_name:
        try:
            old_stdout = sys.stdout
            sys.stdout = open(os.devnull, 'w')
            from insightface.app import FaceAnalysis
            app = FaceAnalysis(name=model_name, providers=['CPUExecutionProvider'])
            app.prepare(ctx_id=0, det_size=(640, 640))
            sys.stdout.close()
            sys.stdout = old_stdout
            _apps[model_name] = app
            return app, model_name
        except Exception:
            sys.stdout.close()
            sys.stdout = old_stdout
            return None, None

    for name in MODEL_CHAIN:
        if name in _apps:
            return _apps[name], name
        try:
            old_stdout = sys.stdout
            sys.stdout = open(os.devnull, 'w')
            from insightface.app import FaceAnalysis
            app = FaceAnalysis(name=name, providers=['CPUExecutionProvider'])
            app.prepare(ctx_id=0, det_size=(640, 640))
            sys.stdout.close()
            sys.stdout = old_stdout
            _apps[name] = app
            return app, name
        except Exception:
            try:
                sys.stdout.close()
                sys.stdout = old_stdout
            except:
                pass
            continue

    return None, None

def read_image(image_path):
    img = cv2.imread(image_path)
    if img is not None:
        return img

    try:
        from PIL import Image
        import pillow_heif
        pillow_heif.register_heif_opener()
        pil_img = Image.open(image_path)
        if pil_img.mode != 'RGB':
            pil_img = pil_img.convert('RGB')
        return cv2.cvtColor(np.array(pil_img), cv2.COLOR_RGB2BGR)
    except Exception:
        return None

def analyze_face(image_path, model_name=None):
    t0 = time.time()
    img = read_image(image_path)
    if img is None:
        return {"success": False, "error": "Cannot read image"}

    h_img, w_img = img.shape[:2]

    app, used_model = get_app(model_name)
    if app is None:
        return {"success": False, "error": "No face model available"}

    faces_data = app.get(img)

    results = []
    for i, face in enumerate(faces_data):
        fx, fy, fw, fh = face.bbox.astype(int)
        fx, fy = max(0, fx), max(0, fy)
        fw, fh = min(fw, w_img), min(fh, h_img)
        face_w, face_h = fw - fx, fh - fy
        if face_w < 10 or face_h < 10:
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
        face_img = img[fy:fh, fx:fw]
        face_gray = cv2.cvtColor(face_img, cv2.COLOR_BGR2GRAY) if face_img.size > 0 else np.zeros((64, 64), dtype=np.uint8)

        small = cv2.resize(face_gray, (9, 8)) if face_gray.size > 0 else np.zeros((8, 9), dtype=np.uint8)
        diff = small[:, 1:] > small[:, :-1]
        phash = int(sum(2**j for j, v in enumerate(diff.flatten()) if v))

        resized = cv2.resize(face_gray, (9, 9)) if face_gray.size > 0 else np.zeros((9, 9), dtype=np.uint8)
        dhash = int(sum(2**j for j, v in enumerate((resized[:, 1:] > resized[:, :-1]).flatten()) if v))

        thumb = cv2.resize(face_img, (128, 128)) if face_img.size > 0 else np.zeros((128, 128, 3), dtype=np.uint8)
        _, thumb_buf = cv2.imencode('.jpg', thumb, [cv2.IMWRITE_JPEG_QUALITY, 85])
        thumb_b64 = base64.b64encode(thumb_buf).decode()

        eyes = eye_cascade.detectMultiScale(face_gray, 1.1, 3) if face_gray.size > 0 else []
        has_glasses = len(eyes) == 0 and face_w > 80

        # MagFace-like quality score (embedding magnitude)
        quality_score = 0
        if embedding:
            magnitude = np.sqrt(sum(x*x for x in embedding))
            quality_score = float(magnitude)

        results.append({
            "index": i,
            "confidence": min(1.0, round(max(0.4, det_score), 2)),
            "gender": gender,
            "age_group": age_group,
            "age_approx": age,
            "has_glasses": bool(has_glasses),
            "perceptual_hash": phash,
            "dhash": dhash,
            "face_descriptor": {
                "phash": phash,
                "dhash": dhash,
                "embedding": embedding,
                "landmarks": kps,
                "det_score": round(det_score, 4),
                "quality_score": round(quality_score, 4)
            },
            "thumbnail": thumb_b64
        })

    elapsed = round((time.time() - t0) * 1000)

    return {
        "success": True,
        "faces": results,
        "elapsed": elapsed,
        "model": used_model,
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
        print(json.dumps({"error": "Usage: python face_multimodel.py <image_path> [model_name]"}))
        sys.exit(1)

    if sys.argv[1] == '--worker':
        # Persistent worker mode: read file paths from stdin, one per line
        import sys
        model = sys.argv[2] if len(sys.argv) > 2 else None
        # Pre-load the model once
        get_app(model)
        for line in sys.stdin:
            line = line.strip()
            if not line or line == 'QUIT':
                break
            try:
                result = analyze_face(line)
                print(json.dumps(result))
                sys.stdout.flush()
            except Exception as e:
                print(json.dumps({"success": False, "error": str(e)}))
                sys.stdout.flush()
    else:
        model = sys.argv[2] if len(sys.argv) > 2 else None
        result = analyze_face(sys.argv[1], model)
        print(json.dumps(result))
