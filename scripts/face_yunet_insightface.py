import cv2
import sys
import json
import os
import time
import base64
import numpy as np

# Add CUDA DLL directories for Windows Python 3.8+
if sys.platform == 'win32':
    import ctypes
    cuda_base = r'C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v13.3'
    nvidia_paths = [
        r'C:\Users\HKC-USER\AppData\Roaming\Python\Python314\site-packages\nvidia\cu13\bin\x86_64',
        r'C:\Users\HKC-USER\AppData\Roaming\Python\Python314\site-packages\nvidia\cudnn\bin',
        r'C:\Users\HKC-USER\AppData\Roaming\Python\Python314\site-packages\nvidia\cuda_nvrtc\bin',
        os.path.join(cuda_base, 'bin', 'x64'),
        os.path.join(cuda_base, 'bin'),
    ]
    for p in nvidia_paths:
        if os.path.isdir(p):
            os.add_dll_directory(p)
            # Also preload critical DLLs via ctypes
            for dll in os.listdir(p):
                if dll.endswith('.dll'):
                    try:
                        ctypes.cdll.LoadLibrary(os.path.join(p, dll))
                    except Exception:
                        pass

CASCADE_PATH = cv2.data.haarcascades + 'haarcascade_eye.xml'
eye_cascade = cv2.CascadeClassifier(CASCADE_PATH)

_yunet_model = None
_insightface_app = None
_insightface_model_name = None

def get_yunet():
    global _yunet_model
    if _yunet_model is None:
        model_path = os.path.join(os.path.dirname(__file__), '..', 'models', 'yunet_face.onnx')
        _yunet_model = cv2.FaceDetectorYN.create(model_path, '', (640, 640))
    return _yunet_model

def get_insightface(model_name='buffalo_l'):
    global _insightface_app, _insightface_model_name
    if _insightface_app is None or _insightface_model_name != model_name:
        old_stdout = sys.stdout
        sys.stdout = open(os.devnull, 'w')
        try:
            from insightface.app import FaceAnalysis
            import onnxruntime as ort
            providers = ['CUDAExecutionProvider', 'CPUExecutionProvider'] if 'CUDAExecutionProvider' in ort.get_available_providers() else ['CPUExecutionProvider']
            _insightface_app = FaceAnalysis(name=model_name, providers=providers)
            _insightface_app.prepare(ctx_id=0, det_size=(1920, 1920))
            _insightface_model_name = model_name
        finally:
            sys.stdout.close()
            sys.stdout = old_stdout
    return _insightface_app

def analyze_face(image_path, model_name='buffalo_l'):
    t0 = time.time()
    img = cv2.imread(image_path)
    if img is None:
        try:
            from PIL import Image
            import pillow_heif
            pillow_heif.register_heif_opener()
            pil_img = Image.open(image_path)
            if pil_img.mode != 'RGB':
                pil_img = pil_img.convert('RGB')
            img = cv2.cvtColor(np.array(pil_img), cv2.COLOR_RGB2BGR)
        except Exception:
            return {"success": False, "error": "Cannot read image"}

    h_img, w_img = img.shape[:2]

    # Step 1: Detect faces with YuNet (resize for better detection)
    yunet = get_yunet()

    # Resize image for YuNet detection (works better at smaller sizes)
    max_dim = 1024
    scale = min(max_dim / w_img, max_dim / h_img, 1.0)
    if scale < 1.0:
        det_img = cv2.resize(img, (int(w_img * scale), int(h_img * scale)))
    else:
        det_img = img

    det_h, det_w = det_img.shape[:2]
    yunet.setInputSize((det_w, det_h))
    _, faces = yunet.detect(det_img)

    if faces is None or len(faces) == 0:
        return {"success": True, "faces": [], "elapsed": round((time.time() - t0) * 1000),
                "model": f"yunet+{model_name}", "filePath": image_path,
                "summary": {"faceCount": 0, "hasFaces": False}}

    # Scale bounding boxes back to original image size
    if scale < 1.0:
        for i in range(len(faces)):
            faces[i][0] /= scale
            faces[i][1] /= scale
            faces[i][2] /= scale
            faces[i][3] /= scale

    if faces is None or len(faces) == 0:
        return {"success": True, "faces": [], "elapsed": round((time.time() - t0) * 1000),
                "model": f"yunet+{model_name}", "filePath": image_path,
                "summary": {"faceCount": 0, "hasFaces": False}}

    # Step 2: For each detected face, crop and compute InsightFace embedding
    insightface = get_insightface(model_name)
    results = []

    for i, face_data in enumerate(faces):
        x, y, w, h = face_data[:4].astype(int)
        confidence = float(face_data[4])

        x = max(0, x)
        y = max(0, y)
        w = min(w, w_img - x)
        h = min(h, h_img - y)

        if w < 10 or h < 10:
            continue

        # Add padding for better embedding
        pad_x = int(w * 0.3)
        pad_y = int(h * 0.3)
        x1 = max(0, x - pad_x)
        y1 = max(0, y - pad_y)
        x2 = min(w_img, x + w + pad_x)
        y2 = min(h_img, y + h + pad_y)

        face_crop = img[y1:y2, x1:x2]
        if face_crop.size == 0:
            continue

        # Get InsightFace embedding from the crop
        face_results = insightface.get(face_crop)

        if not face_results:
            # Fallback: try full image
            face_results = insightface.get(img)
            # Find the face closest to our YuNet bbox
            if face_results:
                best = None
                best_dist = float('inf')
                for fr in face_results:
                    fx, fy = fr.bbox[0], fr.bbox[1]
                    dist = np.sqrt((fx - x)**2 + (fy - y)**2)
                    if dist < best_dist:
                        best_dist = dist
                        best = fr
                face_results = [best] if best else []

        if not face_results:
            continue

        # Use the best matching InsightFace result
        best_face = face_results[0]
        
        # Landmark validation: reject if landmarks don't form a face pattern
        if best_face.kps is not None and len(best_face.kps) == 5:
            kps = best_face.kps
            # Check: eyes should be above nose, nose above mouth
            left_eye_y = kps[0][1]
            right_eye_y = kps[1][1]
            nose_y = kps[2][1]
            mouth_y = (kps[3][1] + kps[4][1]) / 2
            
            # Eyes should be above nose, nose above mouth
            if not (left_eye_y < nose_y and right_eye_y < nose_y and nose_y < mouth_y):
                continue  # Invalid face pattern - skip this detection
        
        embedding = best_face.embedding.tolist() if best_face.embedding is not None else None

        gender = 'male' if best_face.gender == 1 else 'female' if best_face.gender == 0 else 'unknown'
        age = int(best_face.age) if best_face.age is not None else 30

        if age > 25: age_group = 'adult'
        elif age > 18: age_group = 'young_adult'
        elif age > 12: age_group = 'teen'
        else: age_group = 'child'

        kps = best_face.kps.tolist() if best_face.kps is not None else []

        # Use YuNet's bbox for the stored coordinates (covers full head area)
        # x, y, w, h are already in original image coords from YuNet detection
        yunet_x = max(0, x)
        yunet_y = max(0, y)
        yunet_w = min(w, w_img - yunet_x)
        yunet_h = min(h, h_img - yunet_y)

        head_bbox = {
            "x": int(yunet_x),
            "y": int(yunet_y),
            "width": int(yunet_w),
            "height": int(yunet_h)
        }

        # Add padding around YuNet bbox for thumbnail
        pad_x = int(yunet_w * 0.3)
        pad_y = int(yunet_h * 0.3)
        crop_x1 = max(0, yunet_x - pad_x)
        crop_y1 = max(0, yunet_y - pad_y)
        crop_x2 = min(w_img, yunet_x + yunet_w + pad_x)
        crop_y2 = min(h_img, yunet_y + yunet_h + pad_y)
        face_img = img[crop_y1:crop_y2, crop_x1:crop_x2] if (crop_x2 > crop_x1 and crop_y2 > crop_y1) else img[y:y+h, x:x+w]
        face_gray = cv2.cvtColor(face_img, cv2.COLOR_BGR2GRAY) if face_img.size > 0 else np.zeros((64, 64), dtype=np.uint8)

        small = cv2.resize(face_gray, (9, 8)) if face_gray.size > 0 else np.zeros((8, 9), dtype=np.uint8)
        diff = small[:, 1:] > small[:, :-1]
        phash = int(sum(2**j for j, v in enumerate(diff.flatten()) if v))

        resized = cv2.resize(face_gray, (9, 9)) if face_gray.size > 0 else np.zeros((9, 9), dtype=np.uint8)
        dhash = int(sum(2**j for j, v in enumerate((resized[:, 1:] > resized[:, :-1]).flatten()) if v))

        # Resize maintaining aspect ratio, pad to 128x128 square
        if face_img.size > 0:
            fh, fw = face_img.shape[:2]
            scale = min(128 / fw, 128 / fh)
            new_w = int(fw * scale)
            new_h = int(fh * scale)
            resized_face = cv2.resize(face_img, (new_w, new_h))
            thumb = np.zeros((128, 128, 3), dtype=np.uint8)
            x_off = (128 - new_w) // 2
            y_off = (128 - new_h) // 2
            thumb[y_off:y_off+new_h, x_off:x_off+new_w] = resized_face
        else:
            thumb = np.zeros((128, 128, 3), dtype=np.uint8)
        _, thumb_buf = cv2.imencode('.jpg', thumb, [cv2.IMWRITE_JPEG_QUALITY, 85])
        thumb_b64 = base64.b64encode(thumb_buf).decode()

        eyes = eye_cascade.detectMultiScale(face_gray, 1.1, 3) if face_gray.size > 0 else []
        has_glasses = len(eyes) == 0 and w > 80

        det_score = float(best_face.det_score) if best_face.det_score is not None else confidence

        results.append({
            "index": i,
            "confidence": min(1.0, round(max(0.4, det_score), 2)),
            "gender": gender,
            "age_group": age_group,
            "age_approx": age,
            "has_glasses": bool(has_glasses),
            "perceptual_hash": phash,
            "dhash": dhash,
            "bbox": head_bbox,
            "face_descriptor": {
                "phash": phash,
                "dhash": dhash,
                "embedding": embedding,
                "landmarks": kps,
                "det_score": round(det_score, 4),
                "quality_score": round(float(np.linalg.norm(embedding)) if embedding else 0, 4)
            },
            "thumbnail": thumb_b64
        })

    elapsed = round((time.time() - t0) * 1000)

    return {
        "success": True,
        "faces": results,
        "elapsed": elapsed,
        "model": f"yunet+{model_name}",
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
        print(json.dumps({"error": "Usage: python face_yunet_insightface.py <image_path> [--worker]"}))
        sys.exit(1)

    if sys.argv[1] == '--worker':
        # Pre-load models with default model
        get_yunet()
        get_insightface('buffalo_l')
        sys.stderr.write("Models loaded\n")
        sys.stderr.flush()

        for line in sys.stdin:
            line = line.strip()
            if not line or line == 'QUIT':
                break
            try:
                # Support both JSON and plain path input
                if line.startswith('{'):
                    msg = json.loads(line)
                    image_path = msg.get('path', '')
                    model_name = msg.get('model', 'buffalo_l')
                else:
                    image_path = line
                    model_name = 'buffalo_l'
                result = analyze_face(image_path, model_name)
                print(json.dumps(result))
                sys.stdout.flush()
            except Exception as e:
                print(json.dumps({"success": False, "error": str(e)}))
                sys.stdout.flush()
    else:
        result = analyze_face(sys.argv[1])
        print(json.dumps(result))
