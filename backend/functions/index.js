const {onRequest} = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");
const puppeteer = require("puppeteer-core"); // Using puppeteer for headless browser
const cors = require("cors")({origin: true});
const admin = require("firebase-admin");
admin.initializeApp();

const { GoogleGenerativeAI } = require("@google/generative-ai");
const GEMINI_API_KEY_SECRET = 'GEMINI_API_KEY';
const BROWSERLESS_API_KEY_SECRET = 'BROWSERLESS_API_KEY';

exports.analyseJobPosting = onRequest(
  { secrets: [GEMINI_API_KEY_SECRET, BROWSERLESS_API_KEY_SECRET], timeoutSeconds: 300 },
  (request, response) => {
    cors(request, response, async () => {
      logger.info("analyseJobPosting function triggered!");
      const jobUrl = request.query.url;
      if (!jobUrl) { return response.status(400).send("Please provide a URL."); }
      logger.info("Analyzing URL:", jobUrl);

      try {
        const browserlessApiKey = process.env.BROWSERLESS_API_KEY;
        const browser = await puppeteer.connect({
          // --- THIS IS THE ONLY LINE THAT CHANGED ---
          browserWSEndpoint: `wss://production-sfo.browserless.io?token=${browserlessApiKey}`
        });
        const page = await browser.newPage();
        await page.goto(jobUrl, { waitUntil: 'networkidle2' });
        const pageText = await page.evaluate(() => document.body.innerText);
        await browser.close();

        if (!pageText || pageText.length < 100) {
          throw new Error(`Scraped text was too short or empty. Length: ${pageText.length}`);
        }
        logger.info("Successfully scraped text. Length:", pageText.length);

        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        const prompt = `Based on the following text from a job posting webpage, extract the company name, job title, and location. Return the result as a clean JSON object only. Here is the text: "${pageText.substring(0, 8000)}"`;
        
        const result = await model.generateContent(prompt);
        const aiResponse = result.response.text();
        logger.info("Raw AI Response:", aiResponse);

        let jobData;
        try {
          const jsonText = aiResponse.replace(/```json/g, '').replace(/```/g, '').trim();
          jobData = JSON.parse(jsonText);
        } catch (e) {
          logger.error("AI did not return valid JSON. Response was:", aiResponse);
          jobData = { jobTitle: "Could not parse AI response", errorResponse: aiResponse };
        }

        jobData.trackedAt = admin.firestore.FieldValue.serverTimestamp();
        jobData.originalUrl = jobUrl;
        
        const writeResult = await admin.firestore().collection('tracked_jobs').add(jobData);
        logger.info(`Successfully saved job with ID: ${writeResult.id} to Firestore.`);

        response.setHeader('Content-Type', 'application/json');
        response.status(200).send(jobData);

      } catch (error) {
        logger.error("An error occurred:", error);
        response.status(500).send(`Failed to analyze the URL. Error: ${error.message}`);
      }
    });
  }
);