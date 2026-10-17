-- Local-only authority metadata. Existing grants, observations and captured deadlines are unchanged.
CREATE TABLE research_personal_contracts ( contract_hash TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES research_sources(source_id), exception_id TEXT NOT NULL, config_hash TEXT NOT NULL, contract_json TEXT NOT NULL CHECK(json_valid(contract_json)), UNIQUE(source_id,exception_id) );
CREATE TRIGGER research_personal_contracts_immutable BEFORE UPDATE ON research_personal_contracts BEGIN SELECT RAISE(ABORT,'immutable_personal_contract'); END;
CREATE TABLE research_personal_runs ( run_id TEXT PRIMARY KEY REFERENCES research_runs(run_id), contract_hash TEXT NOT NULL REFERENCES research_personal_contracts(contract_hash), UNIQUE(contract_hash) );
CREATE TRIGGER research_personal_runs_immutable BEFORE UPDATE ON research_personal_runs BEGIN SELECT RAISE(ABORT,'immutable_personal_run'); END;
