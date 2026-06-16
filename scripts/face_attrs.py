import cv2
import sys
import json
import os
import time
import base64
import numpy as np

CASCADE_PATH = cv2.data.haarcascades + 'haarcascade_frontalface_default.xml'
EYE_CASCADE_PATH = cv2.data.haarcascades + 'haarcascade_eye.xml'
SMILE_CASCADE_PATH = cv2.data.haarcascades + 'haarcascade_smile.xml'

face_cascade = cv2.CascadeClassifier(CASCADE_PATH)
eye_cascade = cv2.CascadeClassifier(EYE_CASCADE_PATH)
smile_cascade = cv2.CascadeClassifier(SMILE_CASCADE_PATH)

def estimate_age(w, h, img_w, img_h):
    face_ratio = w / img_w
    if face_ratio > 0.15:
        return 'adult', 30
    elif face_ratio > 0.08:
        return 'young_adult', 22
    elif face_ratio > 0.04:
        return 'teen', 15
    else:
        return 'child', 8

def estimate_gender(face_img, face_gray):
    h, w = face_img.shape[:2]
    
    # Face shape analysis
    aspect = w / h if h > 0 else 1.0
    
    # Jawline detection (lower face width)
    lower_half = face_gray[h//2:, :]
    lower_width = cv2.countNonZero(cv2.threshold(lower_half, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)[1])
    upper_half = face_gray[:h//2, :]
    upper_width = cv2.countNonZero(cv2.threshold(upper_half, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)[1])
    
    jaw_ratio = lower_width / (upper_width + 1)
    
    # Skin smoothness (simplified)
    blur = cv2.Laplacian(face_gray, cv2.CV_64F).var()
    
    # Heuristic
    if jaw_ratio > 1.1 and blur < 500:
        return 'male', 0.6
    elif jaw_ratio < 0.9 or blur > 800:
        return 'female', 0.6
    else:
        return 'unknown', 0.4

def detect_expression(face_gray, x, y, w, h, full_gray):
    # Smile detection
    roi = full_gray[max(0,y):min(full_gray.shape[0],y+h), max(0,x):min(full_gray.shape[1],x+w)]
    if roi.size == 0:
        return 'neutral', 0.5
    
    smiles = smile_cascade.detectMultiScale(roi, 1.7, 20)
    if len(smiles) > 0:
        return 'smiling', 0.7
    
    # Eye aspect ratio for engagement
    eyes = eye_cascade.detectMultiScale(roi, 1.1, 3)
    if len(eyes) >= 2:
        return 'looking_at_camera', 0.6
    elif len(eyes) == 1:
        return 'looking_away', 0.5
    
    return 'neutral', 0.5

def analyze_face(image_path):
    t0 = time.time()
    img = cv2.imread(image_path)
    if img is None:
        return {"success": False, "error": "Cannot read image"}
    
    h_img, w_img = img.shape[:2]
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    gray = cv2.equalizeHist(gray)
    
    faces = face_cascade.detectMultiScale(gray, 1.08, 6, minSize=(40, 40))
    
    results = []
    for i, (x, y, w, h) in enumerate(faces):
        face_img = img[y:y+h, x:x+w]
        face_gray = gray[y:y+h, x:x+w]
        
        # Age estimation
        age_group, age_approx = estimate_age(w, h, w_img, h_img)
        
        # Gender estimation
        gender, gender_conf = estimate_gender(face_img, face_gray)
        
        # Expression detection
        expression, expr_conf = detect_expression(face_gray, x, y, w, h, gray)
        
        # Glasses detection
        eyes = eye_cascade.detectMultiScale(face_gray, 1.1, 3)
        has_glasses = len(eyes) == 0 and w > 80
        
        # Thumbnail
        thumb = cv2.resize(face_img, (128, 128))
        _, thumb_buf = cv2.imencode('.jpg', thumb, [cv2.IMWRITE_JPEG_QUALITY, 85])
        thumb_b64 = base64.b64encode(thumb_buf).decode()
        
        # Perceptual hash
        small = cv2.resize(gray[y:y+h, x:x+w], (9, 8))
        diff = small[:, 1:] > small[:, :-1]
        phash = sum(2**i for i, v in enumerate(diff.flatten()) if v)
        
        # Confidence based on face size
        confidence = min(1.0, round(max(0.4, 0.3 + (w/w_img) * 5), 2))
        
        results.append({
            "index": i,
            "confidence": confidence,
            "bbox": {"x": int(x), "y": int(y), "width": int(w), "height": int(h)},
            "gender": gender,
            "gender_confidence": round(gender_conf, 2),
            "age_group": age_group,
            "age_approx": age_approx,
            "expression": expression,
            "expression_confidence": round(expr_conf, 2),
            "has_glasses": bool(has_glasses),
            "perceptual_hash": phash,
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
        print(json.dumps({"error": "Usage: python face_attrs.py <image_path>"}))
        sys.exit(1)
    result = analyze_face(sys.argv[1])
    print(json.dumps(result))
