# System Architecture

## Overview
The AI Pack Manager is a lightweight, responsive web application built on a client-server architecture. The frontend provides a dynamic 3D operational dashboard, while the backend orchestrates the Gemini multimodal AI to perform visual reasoning.

## Components
1. **Frontend UI (HTML/CSS/Vanilla JS)**
   - Provides a responsive, 3D glassmorphism interface.
   - Handles webcam media streams for real-time capture.
   - Manages state for the expected order payload.
2. **Backend Server (FastAPI)**
   - Exposes a RESTful `/api/verify` endpoint.
   - Serves static assets.
   - Manages environment variables and API authentication.
3. **AI Engine (Google Gemini 3.5 Flash)**
   - Acts as the core reasoning engine, performing visual-language alignment.

## Data Flow
1. **Input Generation**: The user defines the Expected Order JSON array via the UI.
2. **Capture**: The user captures a frame from the live webcam feed or uploads an image blob.
3. **Transmission**: The frontend packages the image blob and JSON order data into a `FormData` object and POSTs it to `/api/verify`.
4. **Prompt Construction**: The FastAPI backend parses the inputs, initializes the Gemini model, and constructs a strict system prompt embedding the Expected Order JSON alongside the image bytes.
5. **Inference**: The Gemini model processes the multimodal input and generates a structured JSON response identifying missing, wrong, and extra items, a final operational decision, reasoning, and a confidence score.
6. **Presentation**: The backend passes the JSON payload back to the frontend, which dynamically renders the verdict banner, issue lists, and confidence meter.

## Model / Agent Usage
- **Model**: `gemini-3.5-flash`
- **Usage**: The model is utilized in a zero-shot capacity with strict structural constraints. By defining a specific JSON schema in the prompt and dictating rule-based outcomes (e.g., "If items are missing... decision is STOP & FIX"), we constrain the LLM to behave deterministically as a state-machine agent rather than an open-ended conversational bot.
- **Handling Uncertainty**: The agent is explicitly instructed that "UNCERTAIN is a valid outcome" to prevent hallucination when image quality is poor.

## Important Engineering Decisions
- **Vanilla JS over Frameworks**: To keep the repository lightweight and easily deployable for the hackathon, the frontend avoids heavy frameworks like React in favor of vanilla JavaScript and CSS, while still delivering a highly interactive 3D UI.
- **FastAPI**: Chosen for its native asynchronous support, allowing the backend to handle high-throughput image uploads and API requests without blocking.
- **Simulated Integrations**: The UI includes a mock WMS Barcode Scanner to demonstrate how the agent would integrate into an existing operational workflow, prioritizing business value context for the judges.
