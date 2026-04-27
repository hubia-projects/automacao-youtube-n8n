const makeInitialState = ({ videoId, topic = "", angle = "", selectedIdea = null }) => {
  const now = new Date().toISOString();
  return {
    video_id: videoId,
    idea_id: null,
    topic,
    angle,
    status: "initialized",
    current_step: "initialized",
    approved: false,
    selected_idea: selectedIdea,
    ideas: [],
    research_json: {},
    outline_json: {},
    script_text: "",
    script_path: "",
    audio_path: "",
    duration_seconds: 0,
    caption_path_srt: "",
    caption_path_vtt: "",
    assets_json: {
      visual_keywords: [],
      search_queries: [],
      items: [],
      fallback_plan: [],
      missing_assets: false,
    },
    render_path: "",
    thumbnail_path: "",
    youtube_title: "",
    youtube_description: "",
    youtube_tags: [],
    youtube_chapters: [],
    youtube_video_id: "",
    youtube_url: "",
    error_message: "",
    state_path: "",
    created_at: now,
    updated_at: now,
  };
};

module.exports = { makeInitialState };