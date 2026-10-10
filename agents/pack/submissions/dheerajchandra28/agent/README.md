# AI Pack Manager Agent

## Problem Understanding
In outbound fulfillment, shipping the wrong items or incorrect quantities leads to poor customer experience, high return costs, and lost revenue. Before sealing a box, an operator must verify if the contents precisely match the customer's order. Doing this manually is slow and error-prone, especially in high-volume environments. 

## Solution Overview
The AI Pack Manager is an intelligent verification system that leverages the Gemini Vision model to visually inspect the contents of an open package. It acts as a digital quality assurance agent. By comparing a live camera feed or uploaded photo against the expected order (SKUs and quantities), it automatically categorizes items as detected, missing, wrong, or extra, and makes a final operational decision to either **SEAL** the box or **STOP & FIX**.

## Setup Instructions
1. Clone this repository.
2. Install the required dependencies:
   ```bash
   pip install -r requirements.txt
   ```
3. Create a `.env` file in the root directory and add your Google Gemini API key:
   ```env
   GEMINI_API_KEY=your_api_key_here
   ```
4. Run the FastAPI server:
   ```bash
   python main.py
   ```

## Usage Instructions
1. Navigate to `http://localhost:8000` in your web browser.
2. Define the expected order by adding SKUs and quantities (or click "Scan Order Barcode" to simulate fetching from a WMS).
3. Use the "Live Camera" feature to capture the physical package, or upload an image.
4. Click "Initialize Neural Verification" to run the visual analysis.
5. Review the AI's verdict (SEAL/STOP & FIX), confidence score, and breakdown of discrepancies.

## Assumptions & Limitations
- **Assumptions**: The system assumes the entire contents of the package are visible from a top-down camera angle. Hidden items underneath other items will not be detected.
- **Limitations**: The agent currently relies on the LLM's general knowledge to identify SKUs by text. A production deployment would augment this by injecting reference product catalog images into the prompt for direct visual comparison.
