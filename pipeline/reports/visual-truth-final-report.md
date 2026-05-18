# Visual Truth Final Report

- video_id: security_test_1778849669206
- render_path: \app\pipeline\output\draft\security_test_1778849669206\render\final.mp4
- upload_source_path: \app\pipeline\output\draft\security_test_1778849669206\render\final.mp4
- youtube_video_id: mock_security
- ffprobe: 1920x1080 / 77.76s
- state_output_resolution: 
- metadata_boundary_status: pass
- visual_frame_boundary_status: pass
- final_hard_boundary_status: pass
- contact_sheet: pipeline\test_reports\security_test_1778849669206-contact-sheet.jpg
- visual_audit_json: pipeline\test_reports\security_test_1778849669206-visual-audit.json

## Boundary Visual Audit
| Boundary | Expected | Vision | Status |
|---|---|---|---|
| hb_002_lisboa @ 13.06s | Lisboa |  | pass |
| hb_002_lisboa @ 13.46s | Lisboa |  | pass |
| hb_002_lisboa @ 13.96s | Lisboa |  | pass |
| hb_003_porto @ 26.02s | Porto | Porto | pass |
| hb_003_porto @ 26.42s | Porto | Porto | pass |
| hb_003_porto @ 26.92s | Porto | Porto | pass |
| hb_004_portugal-gastronomico-lisboa-porto-mercados-e-vinhos @ 38.98s | Portugal gastronómico: Lisboa, Porto, mercados e vinhos |  | pass |
| hb_004_portugal-gastronomico-lisboa-porto-mercados-e-vinhos @ 39.38s | Portugal gastronómico: Lisboa, Porto, mercados e vinhos |  | pass |
| hb_004_portugal-gastronomico-lisboa-porto-mercados-e-vinhos @ 39.88s | Portugal gastronómico: Lisboa, Porto, mercados e vinhos |  | pass |
| hb_006_fechamento @ 64.9s | Fechamento |  | pass |
| hb_006_fechamento @ 65.3s | Fechamento |  | pass |
| hb_006_fechamento @ 65.8s | Fechamento |  | pass |

## Clip Audit
| Clip | Expected | Query | Metadata | Vision | Status |
|---|---|---|---|---|---|
| 1 | Introducao | lisbon lisbon food market | Lisboa |  | pass |
| 2 | Introducao | lisbon lisbon food market | Lisboa |  | pass |
| 3 | Introducao | portugal portugal food travel | Porto | Porto | pass |
| 4 | Lisboa | lisbon lisbon food market | Lisboa |  | pass |
| 5 | Lisboa | lisbon lisbon food market | Lisboa | Porto | pass |
| 6 | Lisboa | portugal portugal food market |  | Lisbon | pass |
| 7 | Porto | portugal portugal food market | Porto | Porto | pass |
| 8 | Porto | portugal portugal food travel | Porto | Porto | pass |
| 9 | Porto | porto wine cellar |  |  | pass |
| 10 | Portugal gastronómico: Lisboa, Porto, mercados e vinhos | lisbon lisbon food market | Lisboa |  | pass |
| 11 | Portugal gastronómico: Lisboa, Porto, mercados e vinhos | portugal portugal food market |  | Lisbon | pass |
| 12 | Portugal gastronómico: Lisboa, Porto, mercados e vinhos | portugal portugal wine tasting |  | Douro | pass |
| 13 | Portugal gastronómico: Lisboa, Porto, mercados e vinhos | lisbon lisbon food market | Lisboa |  | pass |
| 14 | Portugal gastronómico: Lisboa, Porto, mercados e vinhos | lisbon lisbon food market | Lisboa | Lisbon | pass |
| 15 | Portugal gastronómico: Lisboa, Porto, mercados e vinhos | portugal portugal wine tasting |  | Douro | pass |
| 16 | Fechamento | lisbon lisbon food market | Lisboa |  | pass |
| 17 | Fechamento | portugal portugal wine tasting |  |  | pass |
| 18 | Fechamento | lisbon lisbon food market | Lisboa |  | pass |
