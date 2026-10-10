import os
import json
from fastapi import FastAPI, File, UploadFile, Form
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from typing import List, Optional
import google.generativeai as genai
from dotenv import load_dotenv

load_dotenv()

app = FastAPI(title="Pack Manager Agent")

# Configure CORS if needed
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Configure Gemini API
GENAI_API_KEY = os.environ.get("GEMINI_API_KEY")
if GENAI_API_KEY:
    genai.configure(api_key=GENAI_API_KEY)

class OrderLine(BaseModel):
    sku: str
    quantity: int

@app.post("/api/verify")
async def verify_package(
    expected_order: str = Form(...), 
    image: UploadFile = File(...)
):
    try:
        if not GENAI_API_KEY:
            return JSONResponse(status_code=500, content={"error": "GEMINI_API_KEY environment variable not set."})

        # Parse expected order (Assuming it's a JSON string: [{"sku": "SKU-1", "quantity": 1}])
        try:
            expected_items = json.loads(expected_order)
        except Exception:
            return JSONResponse(status_code=400, content={"error": "Invalid expected_order format. Must be JSON array."})

        # Read image
        image_bytes = await image.read()
        
        # Initialize the model
        model = genai.GenerativeModel('gemini-3.5-flash')
        
        # Formulate prompt for the Pack Manager logic
        prompt = f"""
        You are an AI-powered Pack Manager for a fulfillment center.
        Your job is to analyze the photograph of this open box and verify its contents against the expected order.
        
        Expected Order:
        {json.dumps(expected_items, indent=2)}

        Analyze the image and provide a verification report in the following JSON format:
        {{
            "detected_items": [{{"sku": "identified sku or description", "quantity": count}}],
            "missing_items": [{{"sku": "sku", "quantity": count}}],
            "wrong_items": [{{"sku": "detected sku", "quantity": count}}],
            "extra_items": [{{"sku": "detected extra item", "quantity": count}}],
            "decision": "SEAL" or "STOP & FIX" or "UNCERTAIN",
            "reasoning": "Brief explanation of the decision.",
            "confidence_score": "A number between 0 and 100 representing your confidence in the visual analysis."
        }}
        
        Rules:
        - If everything matches exactly, decision is SEAL.
        - If items are missing, wrong, or extra, decision is STOP & FIX.
        - If the image is blurry, ambiguous, or you can't be sure, decision is UNCERTAIN. Do not invent evidence.
        - Ensure output is strictly valid JSON without any markdown formatting.
        """
        
        response = model.generate_content(
            [
                {'mime_type': image.content_type, 'data': image_bytes},
                prompt
            ]
        )
        
        response_text = response.text.strip()
        if response_text.startswith("```json"):
            response_text = response_text[7:-3]
        elif response_text.startswith("```"):
            response_text = response_text[3:-3]
            
        result = json.loads(response_text)
        return result
        
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})

# Mount the static directory for the frontend UI
os.makedirs("static", exist_ok=True)
app.mount("/", StaticFiles(directory="static", html=True), name="static")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
