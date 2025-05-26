const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;

const app = express();
const port = 3000;

// PostgreSQL configuration
const pool = new Pool({
    user: 'postgres',
    host: 'localhost',
    database: 'job_applications',
    password: 'Veera@0134',
    port: 5432,
});

// Middleware
app.use(cors());
app.use(express.json());

// Serve uploaded files statically
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Configure multer for file uploads to filesystem
const storage = multer.diskStorage({
    destination: async (req, file, cb) => {
        try {
            await fs.mkdir('./Uploads', { recursive: true });
            cb(null, './Uploads');
        } catch (error) {
            cb(error);
        }
    },
    filename: (req, file, cb) => {
        cb(null, `${Date.now()}-${file.originalname}`);
    }
});

const upload = multer({
    storage,
    limits: { fileSize: 2 * 1024 * 1024 }, // 2MB limit
    fileFilter: (req, file, cb) => {
        const fileTypes = /pdf|jpeg|jpg|png/;
        const extname = fileTypes.test(path.extname(file.originalname).toLowerCase());
        const mimetype = fileTypes.test(file.mimetype);
        if (extname && mimetype) {
            return cb(null, true);
        } else {
            cb(new Error('Only PDF, JPG, JPEG, and PNG files are allowed!'));
        }
    }
});

// Submit application
app.post('/api/applications', upload.fields([
    { name: 'resume', maxCount: 1 },
    { name: 'idProof', maxCount: 1 },
    { name: 'sscDocs', maxCount: 10 },
    { name: 'interDocs', maxCount: 10 },
    { name: 'qualificationDocs', maxCount: 10 },
    { name: 'certificates', maxCount: 10 }
]), async (req, res) => {
    try {
        const { personalInfo, workExperience, documents } = req.body;
        const files = req.files;

        if (!personalInfo || !workExperience || !documents) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        const formData = {
            personalInfo: JSON.parse(personalInfo),
            education: {
                ssc: { documents: [] },
                intermediate: { documents: [] },
                qualificationDocuments: []
            },
            workExperience: JSON.parse(workExperience),
            documents: {
                resume: null,
                idProof: null,
                certificates: [],
                currentLocation: JSON.parse(documents).currentLocation,
                preferredLocation: JSON.parse(documents).preferredLocation
            },
            date: new Date().toISOString(),
            status: 'Pending'
        };

        // Handle file uploads with full URL
        const baseUrl = `http://localhost:${port}/uploads/`;
        if (files.resume) {
            formData.documents.resume = {
                name: files.resume[0].originalname,
                path: `${baseUrl}${files.resume[0].filename}`
            };
        }
        if (files.idProof) {
            formData.documents.idProof = {
                name: files.idProof[0].originalname,
                path: `${baseUrl}${files.idProof[0].filename}`
            };
        }
        if (files.sscDocs) {
            formData.education.ssc.documents = files.sscDocs.map(file => ({
                name: file.originalname,
                path: `${baseUrl}${file.filename}`
            }));
        }
        if (files.interDocs) {
            formData.education.intermediate.documents = files.interDocs.map(file => ({
                name: file.originalname,
                path: `${baseUrl}${file.filename}`
            }));
        }
        if (files.qualificationDocs) {
            formData.education.qualificationDocuments = files.qualificationDocs.map(file => ({
                name: file.originalname,
                path: `${baseUrl}${file.filename}`
            }));
        }
        if (files.certificates) {
            formData.documents.certificates = files.certificates.map(file => ({
                name: file.originalname,
                path: `${baseUrl}${file.filename}`
            }));
        }

        const result = await pool.query(
            'INSERT INTO applications (personal_info, education, work_experience, documents, date, status) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
            [formData.personalInfo, formData.education, formData.workExperience, formData.documents, formData.date, formData.status]
        );

        res.status(201).json({ message: 'Application submitted successfully', id: result.rows[0].id });
    } catch (error) {
        console.error('Error submitting application:', error);
        let errorMessage = 'Failed to submit application';
        if (error.message.includes('LIMIT_FILE_SIZE')) {
            errorMessage = 'One or more files exceed the 2MB limit';
        } else if (error.message.includes('Only PDF, JPG, JPEG, and PNG files are allowed')) {
            errorMessage = error.message;
        } else if (error.code === '23505') {
            errorMessage = 'Duplicate application detected';
        }
        res.status(500).json({ error: errorMessage });
    }
});

// Get all applications with optional search and status filter
app.get('/api/applications', async (req, res) => {
    try {
        const { search, status, page = 1, limit = 10 } = req.query;
        const offset = (page - 1) * limit;
        let query = 'SELECT * FROM applications';
        const queryParams = [];

        let conditions = [];
        if (search) {
            conditions.push(
                `(personal_info->>'name' ILIKE $${queryParams.length + 1} OR ` +
                `personal_info->>'email' ILIKE $${queryParams.length + 1} OR ` +
                `personal_info->>'phone' ILIKE $${queryParams.length + 1})`
            );
            queryParams.push(`%${search}%`);
        }
        if (status && status !== 'all') {
            conditions.push(`status = $${queryParams.length + 1}`);
            queryParams.push(status);
        }

        if (conditions.length > 0) {
            query += ' WHERE ' + conditions.join(' AND ');
        }

        query += ' ORDER BY date DESC LIMIT $' + (queryParams.length + 1) + ' OFFSET $' + (queryParams.length + 2);
        queryParams.push(limit, offset);

        const result = await pool.query(query, queryParams);
        const totalResult = await pool.query(
            'SELECT COUNT(*) FROM applications' + (conditions.length > 0 ? ' WHERE ' + conditions.join(' AND ') : ''),
            queryParams.slice(0, queryParams.length - 2)
        );

        res.json({ applications: result.rows, total: parseInt(totalResult.rows[0].count) });
    } catch (error) {
        console.error('Error fetching applications:', error);
        res.status(500).json({ error: 'Failed to fetch applications: ' + error.message });
    }
});

// Update application status
app.patch('/api/applications/:id', async (req, res) => {
    const { id } = req.params;
    const { status } = req.body;

    if (!['Accepted', 'Rejected'].includes(status)) {
        return res.status(400).json({ error: 'Invalid status' });
    }

    try {
        const result = await pool.query(
            'UPDATE applications SET status = $1, date = $2 WHERE id = $3 RETURNING *',
            [status, new Date().toISOString(), id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Application not found' });
        }

        res.json({ message: `Application ${status.toLowerCase()} successfully`, application: result.rows[0] });
    } catch (error) {
        console.error('Error updating application:', error);
        res.status(500).json({ error: 'Failed to update application: ' + error.message });
    }
});

app.listen(port, () => {
    console.log(`Server running on http://localhost:${port}`);
});