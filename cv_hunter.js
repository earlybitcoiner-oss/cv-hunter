const express = require('express');
const cors = require('cors');
const { OpenAI } = require('openai');
const multer = require('multer');
const mammoth = require('mammoth');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');

const app = express();
app.use(cors());
app.use(express.json());

const upload = multer({ dest: 'uploads/' });

const openai = new OpenAI({ 
  apiKey: process.env.GROQ_API_KEY, 
  baseURL: "https://api.groq.com/openai/v1" 
});

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_PASS
  }
});

const usersFile = path.join(__dirname, 'users.json');

function loadUsers() {
  try {
    if (fs.existsSync(usersFile)) return JSON.parse(fs.readFileSync(usersFile, 'utf8'));
  } catch (e) {}
  return [];
}

function saveUsers(users) {
  fs.writeFileSync(usersFile, JSON.stringify(users, null, 2), { encoding: 'utf8' });
}

async function readCVFile(filePath, mimetype) {
  try {
    if (mimetype && mimetype.includes('word') || filePath.endsWith('.docx')) {
      const result = await mammoth.extractRawText({ path: filePath });
      return result.value;
    }
    return fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    try {
      const result = await mammoth.extractRawText({ path: filePath });
      return result.value;
    } catch (e2) {
      return fs.readFileSync(filePath, 'utf8');
    }
  }
}

async function analyzeCV(cvText) {
  const response = await openai.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    messages: [
      { 
        role: 'system', 
        content: 'You are a professional HR analyst. Analyze the CV and return JSON only. No markdown, no backticks, just pure JSON with these fields: name, email, phone, skills (array), experience_years (number), job_titles (array), languages (array), location, summary (one sentence in Hebrew).'
      },
      { 
        role: 'user', 
        content: 'Analyze this CV and return JSON only:\n\n' + cvText.slice(0, 4000)
      }
    ],
    temperature: 0.1,
    max_tokens: 800
  });
  
  try {
    const text = response.choices[0].message.content;
    const clean = text.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch (e) {
    return null;
  }
}

async function findMatchingJobs(cvAnalysis) {
  const response = await openai.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    messages: [
      {
        role: 'system',
        content: 'You are a job matching expert in Israel. Return JSON array only. No markdown. Each item must have: company (string), position (string), email (string), reason (string in Hebrew).'
      },
      {
        role: 'user',
        content: 'Find 8 real Israeli companies hiring for this profile. Return JSON array only:\n' + JSON.stringify({
          skills: cvAnalysis.skills,
          experience: cvAnalysis.experience_years,
          titles: cvAnalysis.job_titles,
          location: cvAnalysis.location
        })
      }
    ],
    temperature: 0.3,
    max_tokens: 1200
  });

  try {
    const text = response.choices[0].message.content;
    const clean = text.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch (e) {
    return [];
  }
}

async function writeCoverLetter(cvAnalysis, job) {
  const response = await openai.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    messages: [
      {
        role: 'system',
        content: 'Write a short professional cover letter in Hebrew. Maximum 150 words.'
      },
      {
        role: 'user',
        content: cvAnalysis.name + ' is applying for ' + job.position + ' at ' + job.company + '. Background: ' + cvAnalysis.summary
      }
    ],
    temperature: 0.7,
    max_tokens: 300
  });
  return response.choices[0].message.content;
}

async function sendEmail(to, subject, body, fromName) {
  try {
    await transporter.sendMail({
      from: '"' + fromName + '" <' + process.env.GMAIL_USER + '>',
      to: to,
      subject: subject,
      text: body
    });
    return true;
  } catch (e) {
    console.error('[EMAIL] Error:', e.message);
    return false;
  }
}

app.post('/api/upload-cv', upload.single('cv'), async function(req, res) {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    
    const cvText = await readCVFile(req.file.path, req.file.mimetype);
    
    if (!cvText || cvText.length < 50) {
      return res.status(400).json({ error: 'Could not read CV file' });
    }
    
    const analysis = await analyzeCV(cvText);
    if (!analysis) return res.status(500).json({ error: 'Could not analyze CV' });
    
    const jobs = await findMatchingJobs(analysis);
    
    const userId = Date.now().toString();
    const users = loadUsers();
    users.push({
      id: userId,
      name: analysis.name,
      email: analysis.email,
      analysis: analysis,
      jobs: jobs,
      sent: [],
      date: new Date().toISOString()
    });
    saveUsers(users);
    
    try { fs.unlinkSync(req.file.path); } catch (e) {}
    
    res.json({ 
      success: true, 
      userId: userId,
      name: analysis.name,
      jobsFound: jobs.length,
      jobs: jobs
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/send-applications', async function(req, res) {
  const { userId } = req.body;
  const users = loadUsers();
  const user = users.find(function(u) { return u.id === userId; });
  
  if (!user) return res.status(404).json({ error: 'User not found' });
  
  const results = [];
  
  for (const job of user.jobs) {
    try {
      const coverLetter = await writeCoverLetter(user.analysis, job);
      
      const emailSent = await sendEmail(
        job.email,
        'פנייה לתפקיד ' + job.position + ' - ' + user.analysis.name,
        coverLetter,
        user.analysis.name
      );
      
      results.push({ 
        company: job.company, 
        position: job.position, 
        email: job.email,
        status: emailSent ? 'sent' : 'failed',
        reason: job.reason,
        coverLetter: coverLetter
      });
    } catch (e) {
      results.push({ company: job.company, position: job.position, status: 'failed' });
    }
    await new Promise(function(r) { setTimeout(r, 1000); });
  }
  
  user.sent = results;
  saveUsers(users);
  
  res.json({ success: true, results: results, total: results.length });
});

app.get('/api/status/:userId', function(req, res) {
  const users = loadUsers();
  const user = users.find(function(u) { return u.id === req.params.userId; });
  if (!user) return res.status(404).json({ error: 'Not found' });
  res.json({ name: user.name, jobsFound: user.jobs.length, sent: user.sent });
});

app.listen(3002, function() {
  console.log('========================================');
  console.log('   CV HUNTER - PORT 3002');
  console.log('========================================');
});
