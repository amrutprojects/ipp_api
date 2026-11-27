-- Landing page CMS (Manage → CMS): what the public landing page shows. One document holds its texts, links, buttons and
-- section switches (missing parts = the defaults of the code, src/modules/cms/defaults.ts); the logo is kept here as an
-- image; courses and FAQs are lists of their own, each one shown or hidden by is_active. Read without sign-in by the
-- landing page (GET /landing), changed by a panel ADMIN. New tables only: nothing existing changes.

CREATE TABLE cms_documents (
  key        varchar(60) PRIMARY KEY,
  value      jsonb NOT NULL CHECK (jsonb_typeof(value) = 'object'),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES panel_users (id) ON DELETE SET NULL
);
CREATE TRIGGER cms_documents_updated_at BEFORE UPDATE ON cms_documents FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- An image of the page (key "logo"): small (the API refuses more than 1 MB), so it is kept in the database and served by
-- GET /landing/logo; `version` (from its content) changes its address whenever the image changes.
CREATE TABLE cms_assets (
  key        varchar(60) PRIMARY KEY,
  mime_type  varchar(60) NOT NULL,
  size_bytes integer NOT NULL CHECK (size_bytes > 0),
  data       bytea NOT NULL,
  version    varchar(64) NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES panel_users (id) ON DELETE SET NULL
);
CREATE TRIGGER cms_assets_updated_at BEFORE UPDATE ON cms_assets FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE cms_courses (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title             varchar(200) NOT NULL,
  -- In lists (hero, footer, the FAQ of the courses); blank = the title.
  short_title       varchar(120),
  description       text NOT NULL DEFAULT '',
  icon              varchar(30) NOT NULL DEFAULT 'code',
  tags              jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(tags) = 'array'),
  -- Off: the card says registration is closed instead of linking to the registration page.
  registration_open boolean NOT NULL DEFAULT true,
  display_order     integer NOT NULL DEFAULT 0,
  is_active         boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz,
  CHECK (deleted_at IS NULL OR NOT is_active)
);
CREATE UNIQUE INDEX uq_cms_courses_title ON cms_courses (lower(title)) WHERE deleted_at IS NULL;
CREATE TRIGGER cms_courses_updated_at BEFORE UPDATE ON cms_courses FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE cms_faqs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  question      varchar(300) NOT NULL,
  answer        text NOT NULL DEFAULT '',
  -- TEXT: the answer as written. COURSES: the answer (an optional introduction) and the list of the shown courses.
  answer_kind   varchar(20) NOT NULL DEFAULT 'TEXT' CHECK (answer_kind IN ('TEXT', 'COURSES')),
  display_order integer NOT NULL DEFAULT 0,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz,
  CHECK (deleted_at IS NULL OR NOT is_active)
);
CREATE UNIQUE INDEX uq_cms_faqs_question ON cms_faqs (lower(question)) WHERE deleted_at IS NULL;
CREATE TRIGGER cms_faqs_updated_at BEFORE UPDATE ON cms_faqs FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- The starting courses and FAQs, so the page is complete right after this migration.
INSERT INTO cms_courses (title, short_title, description, icon, tags, display_order) VALUES
  ('Certification Course in AI, Machine Learning & Data Analytics', 'AI, Machine Learning & Data Analytics',
   'Learn AI fundamentals, machine learning concepts, data processing, analytics, visualization and practical applications.',
   'cpu', '["AI", "Machine Learning", "Data Processing", "Analytics", "Visualization"]', 10),
  ('Certification Course in Artificial Intelligence & Data Science', 'AI & Data Science',
   'Develop skills in Python, data science, statistical analysis, machine learning and AI-based problem solving.',
   'trend', '["Python", "Data Science", "Statistics", "Machine Learning", "AI"]', 20),
  ('Certification Course in Full Stack Development (Python)', 'Full Stack Python',
   'Learn frontend development, Python programming, backend development, database management and full-stack application development.',
   'code', '["Frontend", "Python", "Backend", "Database"]', 30),
  ('Certification Course in Full Stack Development (Java)', 'Full Stack Java',
   'Learn Java programming, backend development, database integration, web technologies and enterprise application development.',
   'coffee', '["Java", "Backend", "Database", "Web Technologies"]', 40),
  ('Certification Course in Full Stack Development (.NET)', 'Full Stack .NET',
   'Learn C# programming, ASP.NET development, database integration, web technologies and full-stack application development.',
   'server', '["C#", "ASP.NET", "Database", "Web Technologies"]', 50),
  ('Certification Course in Full Stack Development (MERN)', 'Full Stack MERN',
   'Learn MongoDB, Express.js, React.js and Node.js to develop modern full-stack web applications.',
   'layers', '["MongoDB", "Express.js", "React.js", "Node.js"]', 60),
  ('Certification Course in Software Testing (Manual + Automation)', 'Software Testing',
   'Learn software testing fundamentals, manual testing, test case design, defect management and test automation.',
   'clipboard', '["Manual Testing", "Test Cases", "Automation", "Defect Tracking"]', 70),
  ('Certification Course in Cyber Security', 'Cyber Security',
   'Learn cyber security fundamentals, network security, threat analysis, vulnerability assessment and security best practices.',
   'shield', '["Network Security", "Threat Analysis", "Vulnerability Assessment", "Security Practices"]', 80);

INSERT INTO cms_faqs (question, answer, answer_kind, display_order) VALUES
  ('Is the programme completely free?',
   'Yes. Training is 100% free for candidates who meet the prescribed eligibility criteria and are approved.', 'TEXT', 10),
  ('Who can apply?',
   'Eligible unemployed Maharashtra residents belonging to the specified Maratha and Kunbi communities, meeting the other prescribed conditions.',
   'TEXT', 20),
  ('What is the duration?', 'The programme duration is three months.', 'TEXT', 30),
  ('What is the minimum attendance requirement?', 'Candidates must maintain at least 90% attendance.', 'TEXT', 40),
  ('Which courses are available?', 'Training is available in the following technologies:', 'COURSES', 50),
  ('Is placement guaranteed?',
   'No. Placement assistance is provided after successful completion, subject to programme guidelines.', 'TEXT', 60),
  ('What is the annual family income limit?', 'Annual family income must be below ₹8 lakh.', 'TEXT', 70),
  ('What is the age limit?', '18 to 35 years.', 'TEXT', 80),
  ('Which documents are required?',
   'The complete document checklist is provided in the Documents Required section above.', 'TEXT', 90),
  ('Where can I register?', 'Register on the official portal: https://ipp.sumago.ai/register', 'TEXT', 100),
  ('How can I access my account?', 'Log in to your account at: https://ipp.sumago.ai/login', 'TEXT', 110),
  ('Can I apply if I have already benefited from another government skill development scheme?',
   'Candidates who have previously availed benefits under another Central or State Government Skill Development Training Scheme are not eligible under the stated criteria.',
   'TEXT', 120);
