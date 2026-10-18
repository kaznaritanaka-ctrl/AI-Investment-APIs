-- Forward-only: works after 0009 and after PR #18's 0012 rebuild.
-- 0010-0013 are reserved by stacked PR #18; do not renumber applied files.
-- Metadata-only assessments survive routine retention deletion of source data.
CREATE TRIGGER IF NOT EXISTS research_retention_assessments_no_delete BEFORE DELETE ON research_retention_assessments BEGIN SELECT RAISE(ABORT,'immutable_research_assessment'); END;
