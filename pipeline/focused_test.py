#!/usr/bin/env python3
"""
Quick focused test for the two failing cases
"""

import requests
import json
from uuid import uuid4

def test_upload_gating():
    """Test YouTube upload gating"""
    video_id = str(uuid4())
    base_url = "http://localhost:8081"
    
    print(f"Testing upload gating with video_id: {video_id}")
    
    # Generate ideas first
    r1 = requests.post(f"{base_url}/api/videos/ideas/generate", 
                      json={"video_id": video_id, "mock_mode": True})
    print(f"Ideas generation: {r1.status_code}")
    
    # Approve first idea
    ideas = r1.json().get('ideas', [])
    if ideas:
        r2 = requests.post(f"{base_url}/api/videos/ideas/approve",
                          json={"video_id": video_id, "idea_id": ideas[0]['idea_id']})
        print(f"Idea approval: {r2.status_code}")
    
    # Generate script
    r3 = requests.post(f"{base_url}/api/videos/script/generate",
                      json={"video_id": video_id, "mock_mode": True})
    print(f"Script generation: {r3.status_code}")
    
    # Generate audio
    r4 = requests.post(f"{base_url}/api/videos/audio/generate",
                      json={"video_id": video_id, "mock_mode": True})
    print(f"Audio generation: {r4.status_code}")
    
    # Generate render
    r5 = requests.post(f"{base_url}/api/videos/render",
                      json={"video_id": video_id, "mock_mode": True})
    print(f"Render generation: {r5.status_code}")
    
    # Set approval to false
    r6 = requests.post(f"{base_url}/api/videos/final/approve",
                      json={"video_id": video_id, "approved": False})
    print(f"Set approval false: {r6.status_code} - {r6.json()}")
    
    # Try upload - should fail
    r7 = requests.post(f"{base_url}/api/videos/youtube/upload",
                      json={"video_id": video_id, "mock_mode": True})
    print(f"Upload attempt (should fail): {r7.status_code} - {r7.json()}")
    
    blocked = r7.json().get('ok') == False and 'aprovação' in r7.json().get('error', '').lower()
    print(f"Upload correctly blocked: {blocked}")
    
    return blocked

def test_validation_error():
    """Test validation error for missing fields"""
    base_url = "http://localhost:8081"
    
    print("Testing validation error for missing video_id")
    
    r = requests.post(f"{base_url}/api/videos/ideas/approve", json={})
    print(f"Missing fields request: {r.status_code} - {r.json()}")
    
    has_error = r.json().get('ok') == False and 'video_id' in r.json().get('error', '')
    print(f"Has validation error: {has_error}")
    
    return has_error

if __name__ == "__main__":
    print("🔍 Testing Upload Gating...")
    result1 = test_upload_gating()
    
    print("\n🔍 Testing Validation Error...")
    result2 = test_validation_error()
    
    print(f"\nResults: Upload Gating: {result1}, Validation: {result2}")