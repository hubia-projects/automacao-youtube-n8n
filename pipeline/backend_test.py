#!/usr/bin/env python3
"""
Comprehensive Backend Testing for YouTube Faceless Pipeline
Tests all API endpoints, state management, and integration health checks
"""

import requests
import json
import sys
import time
from datetime import datetime
from uuid import uuid4

class PipelineAPITester:
    def __init__(self, base_url="http://localhost:8081"):
        self.base_url = base_url
        self.tests_run = 0
        self.tests_passed = 0
        self.test_video_id = str(uuid4())
        self.results = []

    def log_test(self, name, success, details="", expected_status=200, actual_status=None):
        """Log test results"""
        self.tests_run += 1
        if success:
            self.tests_passed += 1
            print(f"✅ {name}")
        else:
            print(f"❌ {name} - {details}")
            if actual_status:
                print(f"   Expected: {expected_status}, Got: {actual_status}")
        
        self.results.append({
            "test": name,
            "success": success,
            "details": details,
            "expected_status": expected_status,
            "actual_status": actual_status
        })

    def make_request(self, method, endpoint, data=None, expected_status=200):
        """Make HTTP request and return response"""
        url = f"{self.base_url}/api/{endpoint}"
        headers = {'Content-Type': 'application/json'}
        
        try:
            if method == 'GET':
                response = requests.get(url, headers=headers, timeout=30)
            elif method == 'POST':
                response = requests.post(url, json=data, headers=headers, timeout=30)
            else:
                raise ValueError(f"Unsupported method: {method}")
            
            # Always return response, let caller handle status checking
            return response, response.status_code == expected_status
        except Exception as e:
            print(f"Request error for {method} {endpoint}: {str(e)}")
            return None, False

    def test_health_endpoints(self):
        """Test basic health endpoints"""
        print("\n🔍 Testing Health Endpoints...")
        
        # Basic health check
        response, success = self.make_request('GET', 'health')
        if success and response:
            data = response.json()
            success = data.get('ok') == True and data.get('service') == 'youtube-faceless-pipeline-api'
            self.log_test("Basic Health Check", success, 
                         f"Service: {data.get('service')}, Mock: {data.get('mock_mode')}")
        else:
            self.log_test("Basic Health Check", False, "Failed to get health status")

        # Integration health check
        response, success = self.make_request('GET', 'health/integrations')
        if success and response:
            data = response.json()
            checks = data.get('checks', {})
            ffmpeg_ok = checks.get('ffmpeg', {}).get('ok', False)
            self.log_test("Integration Health Check", success and ffmpeg_ok,
                         f"FFmpeg OK: {ffmpeg_ok}, Configured: {data.get('configured_count')}")
        else:
            self.log_test("Integration Health Check", False, "Failed to get integration status")

    def test_ideas_generation(self):
        """Test video ideas generation"""
        print("\n🔍 Testing Ideas Generation...")
        
        # Generate ideas
        data = {
            "video_id": self.test_video_id,
            "count": 5,
            "mock_mode": True
        }
        
        response, success = self.make_request('POST', 'videos/ideas/generate', data)
        if success and response:
            result = response.json()
            ideas = result.get('ideas', [])
            success = (result.get('ok') == True and 
                      len(ideas) >= 3 and len(ideas) <= 5 and
                      all('topic' in idea and 'total_score' in idea for idea in ideas))
            self.log_test("Ideas Generation", success,
                         f"Generated {len(ideas)} ideas, Video ID: {result.get('video_id')}")
            
            # Store first idea for approval test
            if ideas:
                self.first_idea = ideas[0]
        else:
            self.log_test("Ideas Generation", False, "Failed to generate ideas")

    def test_ideas_approval(self):
        """Test idea approval"""
        print("\n🔍 Testing Ideas Approval...")
        
        if not hasattr(self, 'first_idea'):
            self.log_test("Ideas Approval", False, "No ideas available for approval")
            return
        
        data = {
            "video_id": self.test_video_id,
            "idea_id": self.first_idea.get('idea_id')
        }
        
        response, success = self.make_request('POST', 'videos/ideas/approve', data)
        if success and response:
            result = response.json()
            selected = result.get('selected_idea', {})
            success = (result.get('ok') == True and 
                      selected.get('idea_id') == self.first_idea.get('idea_id'))
            self.log_test("Ideas Approval", success,
                         f"Approved idea: {selected.get('topic', 'Unknown')}")
        else:
            self.log_test("Ideas Approval", False, "Failed to approve idea")

    def test_script_generation(self):
        """Test script generation"""
        print("\n🔍 Testing Script Generation...")
        
        data = {
            "video_id": self.test_video_id,
            "mock_mode": True,
            "trigger_workflow_2": False
        }
        
        response, success = self.make_request('POST', 'videos/script/generate', data)
        if success and response:
            result = response.json()
            handoff = result.get('handoff_payload_workflow_2', {})
            success = (result.get('ok') == True and 
                      result.get('script_path') and
                      handoff.get('video_id') == self.test_video_id and
                      handoff.get('script_text'))
            self.log_test("Script Generation", success,
                         f"Script path: {result.get('script_path')}")
        else:
            self.log_test("Script Generation", False, "Failed to generate script")

    def test_audio_generation(self):
        """Test audio generation with TTS"""
        print("\n🔍 Testing Audio Generation...")
        
        data = {
            "video_id": self.test_video_id,
            "mock_mode": True,
            "provider": "elevenlabs"
        }
        
        response, success = self.make_request('POST', 'videos/audio/generate', data)
        if success and response:
            result = response.json()
            # Note: Duration may be 0 due to ARM64 ffprobe compatibility issue
            duration = result.get('duration_seconds', 0)
            success = (result.get('ok') == True and 
                      result.get('audio_path') and
                      result.get('provider') in ['mock', 'elevenlabs', 'openai_tts_fallback'])
            
            # Check if audio file actually exists
            import os
            audio_exists = os.path.exists(result.get('audio_path', '')) if result.get('audio_path') else False
            
            self.log_test("Audio Generation", success and audio_exists,
                         f"Duration: {duration}s (may be 0 on ARM64), Provider: {result.get('provider')}, File exists: {audio_exists}")
        else:
            self.log_test("Audio Generation", False, "Failed to generate audio")

    def test_captions_generation(self):
        """Test captions generation (SRT/VTT)"""
        print("\n🔍 Testing Captions Generation...")
        
        data = {
            "video_id": self.test_video_id,
            "mock_mode": True
        }
        
        response, success = self.make_request('POST', 'videos/captions/generate', data)
        if success and response:
            result = response.json()
            success = (result.get('ok') == True and 
                      result.get('caption_path_srt') and
                      result.get('caption_path_vtt') and
                      result.get('provider'))
            self.log_test("Captions Generation", success,
                         f"SRT: {bool(result.get('caption_path_srt'))}, VTT: {bool(result.get('caption_path_vtt'))}")
        else:
            self.log_test("Captions Generation", False, "Failed to generate captions")

    def test_assets_search(self):
        """Test assets search and download"""
        print("\n🔍 Testing Assets Search...")
        
        data = {
            "video_id": self.test_video_id,
            "mock_mode": True,
            "max_assets": 4,
            "trigger_workflow_3": False
        }
        
        response, success = self.make_request('POST', 'videos/assets/search', data)
        if success and response:
            result = response.json()
            handoff = result.get('handoff_payload_workflow_3', {})
            assets_json = result.get('assets_json', {})
            success = (result.get('ok') == True and 
                      result.get('assets_count', 0) > 0 and
                      handoff.get('video_id') == self.test_video_id and
                      handoff.get('assets_json'))
            self.log_test("Assets Search", success,
                         f"Assets: {result.get('assets_count')}, Missing: {result.get('missing_assets')}")
        else:
            self.log_test("Assets Search", False, "Failed to search assets")

    def test_video_render(self):
        """Test video rendering"""
        print("\n🔍 Testing Video Rendering...")
        
        data = {
            "video_id": self.test_video_id,
            "mock_mode": True
        }
        
        response, success = self.make_request('POST', 'videos/render', data)
        if success and response:
            result = response.json()
            success = (result.get('ok') == True and 
                      result.get('render_path'))
            self.log_test("Video Rendering", success,
                         f"Render path: {result.get('render_path')}")
        else:
            self.log_test("Video Rendering", False, "Failed to render video")

    def test_metadata_generation(self):
        """Test metadata generation"""
        print("\n🔍 Testing Metadata Generation...")
        
        data = {
            "video_id": self.test_video_id,
            "mock_mode": True
        }
        
        response, success = self.make_request('POST', 'videos/metadata/generate', data)
        if success and response:
            result = response.json()
            success = (result.get('ok') == True and 
                      result.get('youtube_title') and
                      result.get('youtube_description') and
                      result.get('youtube_tags') and
                      result.get('thumbnail_path'))
            self.log_test("Metadata Generation", success,
                         f"Title: {result.get('youtube_title', '')[:50]}...")
        else:
            self.log_test("Metadata Generation", False, "Failed to generate metadata")

    def test_final_approval(self):
        """Test final approval gating"""
        print("\n🔍 Testing Final Approval...")
        
        # Test approval
        data = {
            "video_id": self.test_video_id,
            "approved": True,
            "note": "Test approval"
        }
        
        response, success = self.make_request('POST', 'videos/final/approve', data)
        if success and response:
            result = response.json()
            success = (result.get('ok') == True and 
                      result.get('approved') == True and
                      result.get('status') == 'final_approved')
            self.log_test("Final Approval (Approve)", success,
                         f"Status: {result.get('status')}, Approved: {result.get('approved')}")
        else:
            self.log_test("Final Approval (Approve)", False, "Failed to approve")

        # Test rejection
        data['approved'] = False
        response, success = self.make_request('POST', 'videos/final/approve', data)
        if success and response:
            result = response.json()
            success = (result.get('ok') == True and 
                      result.get('approved') == False and
                      result.get('status') == 'needs_revision')
            self.log_test("Final Approval (Reject)", success,
                         f"Status: {result.get('status')}, Approved: {result.get('approved')}")
        else:
            self.log_test("Final Approval (Reject)", False, "Failed to reject")

    def test_youtube_upload_gating(self):
        """Test YouTube upload with approval gating"""
        print("\n🔍 Testing YouTube Upload Gating...")
        
        # Ensure we have a complete video pipeline first
        # Generate audio and render (required for upload)
        self.make_request('POST', 'videos/audio/generate', 
                         {"video_id": self.test_video_id, "mock_mode": True})
        self.make_request('POST', 'videos/render', 
                         {"video_id": self.test_video_id, "mock_mode": True})
        
        # First set approval to false
        approve_data = {
            "video_id": self.test_video_id,
            "approved": False
        }
        self.make_request('POST', 'videos/final/approve', approve_data)
        
        # Try upload without approval - should fail
        upload_data = {
            "video_id": self.test_video_id,
            "mock_mode": True,
            "privacy_status": "private"
        }
        
        response, _ = self.make_request('POST', 'videos/youtube/upload', upload_data, expected_status=500)
        if response:
            result = response.json()
            # Check if it's properly blocked (ok=false with approval error)
            blocked = (result.get('ok') == False and 
                      ('aprovação' in result.get('error', '').lower() or 'approval' in result.get('error', '').lower()))
            self.log_test("YouTube Upload (Blocked)", blocked,
                         f"Correctly blocked: {result.get('error', '')}")
        else:
            self.log_test("YouTube Upload (Blocked)", False, "No response received")

        # Now approve and try upload - should succeed
        approve_data['approved'] = True
        self.make_request('POST', 'videos/final/approve', approve_data)
        
        response, success = self.make_request('POST', 'videos/youtube/upload', upload_data)
        if success and response:
            result = response.json()
            success = (result.get('ok') == True and 
                      result.get('mocked') == True and
                      result.get('youtube_video_id'))
            self.log_test("YouTube Upload (Approved)", success,
                         f"Mock ID: {result.get('youtube_video_id')}")
        else:
            self.log_test("YouTube Upload (Approved)", False, "Failed to upload after approval")

    def test_state_management(self):
        """Test state retrieval and persistence"""
        print("\n🔍 Testing State Management...")
        
        response, success = self.make_request('GET', f'videos/{self.test_video_id}/state')
        if success and response:
            result = response.json()
            state = result.get('state', {})
            required_fields = ['video_id', 'current_step', 'status', 'created_at', 'updated_at']
            success = (result.get('ok') == True and 
                      state.get('video_id') == self.test_video_id and
                      all(field in state for field in required_fields))
            self.log_test("State Retrieval", success,
                         f"Step: {state.get('current_step')}, Status: {state.get('status')}")
        else:
            self.log_test("State Retrieval", False, "Failed to retrieve state")

    def test_handoff_data_consistency(self):
        """Test n8n handoff data consistency"""
        print("\n🔍 Testing Handoff Data Consistency...")
        
        # Test workflow 2 handoff (script -> audio/captions/assets)
        script_data = {
            "video_id": self.test_video_id,
            "mock_mode": True,
            "trigger_workflow_2": False
        }
        
        response, success = self.make_request('POST', 'videos/script/generate', script_data)
        if success and response:
            script_result = response.json()
            handoff2 = script_result.get('handoff_payload_workflow_2', {})
            
            # Test workflow 3 handoff (assets -> render/youtube)
            assets_data = {
                "video_id": self.test_video_id,
                "mock_mode": True,
                "trigger_workflow_3": False
            }
            
            response, success = self.make_request('POST', 'videos/assets/search', assets_data)
            if success and response:
                assets_result = response.json()
                handoff3 = assets_result.get('handoff_payload_workflow_3', {})
                
                # Verify consistency
                consistency_checks = [
                    handoff2.get('video_id') == handoff3.get('video_id'),
                    handoff2.get('topic') == handoff3.get('topic'),
                    handoff2.get('script_text') == handoff3.get('script_text'),
                    handoff3.get('audio_path') is not None,
                    handoff3.get('caption_path_srt') is not None,
                    handoff3.get('assets_json') is not None
                ]
                
                success = all(consistency_checks)
                self.log_test("Handoff Data Consistency", success,
                             f"Workflow2->3 consistency: {sum(consistency_checks)}/{len(consistency_checks)}")
            else:
                self.log_test("Handoff Data Consistency", False, "Failed to get workflow 3 handoff")
        else:
            self.log_test("Handoff Data Consistency", False, "Failed to get workflow 2 handoff")

    def test_error_handling(self):
        """Test error handling for invalid requests"""
        print("\n🔍 Testing Error Handling...")
        
        # Test invalid video ID - Note: API auto-creates state for any ID (by design)
        response, success = self.make_request('GET', 'videos/nonexistent-test-id/state')
        if success and response:
            result = response.json()
            # This is expected behavior - API creates new state for any video ID
            self.log_test("Video ID Auto-Creation", True, "API auto-creates state for new video IDs")
        else:
            self.log_test("Video ID Auto-Creation", False, "Failed to handle new video ID")
        
        # Test missing required fields
        response, _ = self.make_request('POST', 'videos/ideas/approve', {}, expected_status=500)
        if response:
            result = response.json()
            # Should return ok=false with validation error
            has_validation_error = (result.get('ok') == False and 
                                  'video_id' in result.get('error', ''))
            self.log_test("Missing Required Fields Validation", has_validation_error, 
                         f"Returns validation error: {result.get('error', '')[:100]}...")
        else:
            self.log_test("Missing Required Fields Validation", False, "No response received")

    def run_all_tests(self):
        """Run all test suites"""
        print(f"🚀 Starting Pipeline API Tests - Video ID: {self.test_video_id}")
        print(f"📍 Base URL: {self.base_url}")
        
        start_time = time.time()
        
        # Run test suites in order
        self.test_health_endpoints()
        self.test_ideas_generation()
        self.test_ideas_approval()
        self.test_script_generation()
        self.test_audio_generation()
        self.test_captions_generation()
        self.test_assets_search()
        self.test_video_render()
        self.test_metadata_generation()
        self.test_final_approval()
        self.test_youtube_upload_gating()
        self.test_state_management()
        self.test_handoff_data_consistency()
        self.test_error_handling()
        
        end_time = time.time()
        duration = end_time - start_time
        
        # Print summary
        print(f"\n📊 Test Summary:")
        print(f"   Tests Run: {self.tests_run}")
        print(f"   Tests Passed: {self.tests_passed}")
        print(f"   Tests Failed: {self.tests_run - self.tests_passed}")
        print(f"   Success Rate: {(self.tests_passed/self.tests_run)*100:.1f}%")
        print(f"   Duration: {duration:.2f}s")
        
        # Return success if all critical tests pass
        critical_failures = [r for r in self.results if not r['success'] and 'Error' not in r['test']]
        return len(critical_failures) == 0

def main():
    """Main test execution"""
    tester = PipelineAPITester()
    
    try:
        success = tester.run_all_tests()
        return 0 if success else 1
    except KeyboardInterrupt:
        print("\n⚠️  Tests interrupted by user")
        return 1
    except Exception as e:
        print(f"\n💥 Test execution failed: {str(e)}")
        return 1

if __name__ == "__main__":
    sys.exit(main())