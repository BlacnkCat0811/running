=== main ===
-- table ability_assessments
CREATE TABLE ability_assessments (
          id TEXT PRIMARY KEY,
          model_run_id TEXT NOT NULL REFERENCES model_runs(id) ON DELETE CASCADE,
          feature_id TEXT NOT NULL REFERENCES workout_features(id),
          training_session_id TEXT NOT NULL REFERENCES training_sessions(id),
          sequence_number INTEGER NOT NULL,
          assessment_status TEXT NOT NULL CHECK (assessment_status IN ('eligible', 'trial', 'excluded', 'calibrating')),
          current_ability REAL,
          efficiency_score REAL,
          pace_score REAL,
          cardio_score REAL,
          stability_score REAL,
          recovery_score REAL,
          effective_weights_json TEXT NOT NULL,
          confidence REAL NOT NULL,
          confidence_factors_json TEXT NOT NULL,
          workout_contribution REAL,
          evidence_strength REAL,
          direction_factor REAL,
          growth_resistance REAL,
          true_ability_before REAL,
          true_ability_after REAL,
          true_ability_delta REAL,
          updated_true_ability INTEGER NOT NULL CHECK (updated_true_ability IN (0, 1)),
          explanation_codes_json TEXT NOT NULL,
          explanation_json TEXT NOT NULL,
          assessed_at TEXT NOT NULL,
          UNIQUE (model_run_id, training_session_id),
          UNIQUE (model_run_id, sequence_number)
        )
-- table active_model_release
CREATE TABLE active_model_release (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1),
      model_run_id TEXT NOT NULL REFERENCES model_release_bundles(model_run_id) ON DELETE RESTRICT
    )
-- table active_model_run
CREATE TABLE active_model_run (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          model_run_id TEXT NOT NULL REFERENCES model_runs(id),
          activated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        )
-- table active_prediction_model
CREATE TABLE active_prediction_model (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          prediction_model_run_id TEXT NOT NULL
            REFERENCES prediction_model_runs(id),
          activated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        )
-- table activity_summaries
CREATE TABLE activity_summaries (
          date_components TEXT PRIMARY KEY,
          attributes_json TEXT NOT NULL
        )
-- table analysis_job_coverage
CREATE TABLE analysis_job_coverage (
      job_id TEXT NOT NULL REFERENCES recompute_jobs(id) ON DELETE CASCADE,
      import_batch_id TEXT NOT NULL,
      dependency_generation_from INTEGER NOT NULL,
      dependency_generation_to INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      PRIMARY KEY (job_id, import_batch_id)
    )
-- table analysis_job_merges
CREATE TABLE analysis_job_merges (
      covered_job_id TEXT PRIMARY KEY REFERENCES recompute_jobs(id) ON DELETE CASCADE,
      covering_job_id TEXT NOT NULL REFERENCES recompute_jobs(id) ON DELETE CASCADE,
      state TEXT NOT NULL CHECK (state IN ('pending','published','released')),
      scope TEXT NOT NULL,
      import_batch_id TEXT NOT NULL,
      covered_dirty_from_at TEXT,
      merged_dirty_from_at TEXT,
      covered_target_raw_generation INTEGER NOT NULL,
      covered_target_dependency_generation INTEGER NOT NULL,
      union_batch_ids_json TEXT NOT NULL,
      evidence_json TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 1,
      binding_job_id TEXT,
      binding_input_digest TEXT,
      binding_override_digest TEXT,
      binding_config_digest TEXT,
      binding_timezone_identifier TEXT,
      binding_captured_raw_generation INTEGER,
      binding_captured_dependency_generation INTEGER,
      covering_model_run_id TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      settled_at TEXT,
      released_at TEXT,
      release_reason TEXT
    )
-- table analysis_run_input_bindings
CREATE TABLE analysis_run_input_bindings (
      run_id TEXT PRIMARY KEY REFERENCES model_runs(id) ON DELETE CASCADE,
      job_id TEXT NOT NULL,
      scope TEXT NOT NULL,
      dataset_version TEXT NOT NULL,
      captured_raw_generation INTEGER NOT NULL,
      captured_dependency_generation INTEGER NOT NULL,
      target_raw_generation INTEGER,
      target_dependency_generation INTEGER,
      incumbent_release_id TEXT,
      timezone_identifier TEXT NOT NULL,
      override_digest TEXT NOT NULL,
      config_digest TEXT NOT NULL,
      cutoff_at TEXT NOT NULL,
      input_digest TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    , executed_plan_json TEXT)
-- table baseline_rebase_reviews
CREATE TABLE baseline_rebase_reviews (
      epoch_id TEXT NOT NULL,
      policy_hash TEXT NOT NULL,
      reviewed_at TEXT NOT NULL,
      model_run_id TEXT NOT NULL,
      status TEXT NOT NULL,
      saturated_reviews INTEGER NOT NULL CHECK(saturated_reviews>=0),
      evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
      PRIMARY KEY(epoch_id,policy_hash,reviewed_at)
    )
-- table canonical_hrv_days
CREATE TABLE canonical_hrv_days (
          id TEXT PRIMARY KEY,
          local_date TEXT NOT NULL,
          timezone_identifier TEXT NOT NULL,
          night_id TEXT NOT NULL REFERENCES canonical_nights(id) ON DELETE CASCADE,
          hrv_sdnn_ms REAL CHECK (hrv_sdnn_ms IS NULL OR hrv_sdnn_ms >= 0),
          sample_count INTEGER NOT NULL DEFAULT 0 CHECK (sample_count >= 0),
          confidence TEXT NOT NULL CHECK (confidence IN ('confident', 'sparse', 'missing')),
          window_start_at TEXT,
          window_end_at TEXT,
          source_name TEXT,
          provenance_json TEXT NOT NULL,
          computed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          UNIQUE (local_date, timezone_identifier)
        )
-- table canonical_nights
CREATE TABLE canonical_nights (
          id TEXT PRIMARY KEY,
          wake_date TEXT NOT NULL,
          timezone_identifier TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('main', 'nap')),
          source_name TEXT NOT NULL,
          source_category TEXT NOT NULL,
          source_rank INTEGER NOT NULL CHECK (source_rank BETWEEN 1 AND 5),
          has_stages INTEGER NOT NULL CHECK (has_stages IN (0, 1)),
          sleep_onset_at TEXT,
          wake_at TEXT,
          asleep_union_minutes REAL CHECK (asleep_union_minutes IS NULL OR asleep_union_minutes >= 0),
          in_bed_union_minutes REAL CHECK (in_bed_union_minutes IS NULL OR in_bed_union_minutes >= 0),
          awake_minutes REAL CHECK (awake_minutes IS NULL OR awake_minutes >= 0),
          stage_minutes_json TEXT NOT NULL,
          segment_count INTEGER NOT NULL CHECK (segment_count >= 0),
          provenance_json TEXT NOT NULL,
          computed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          CHECK (kind <> 'main' OR (sleep_onset_at IS NOT NULL AND wake_at IS NOT NULL AND asleep_union_minutes IS NOT NULL)),
          CHECK (kind <> 'nap' OR sleep_onset_at IS NOT NULL)
        )
-- table coach_fact_operations
CREATE TABLE coach_fact_operations (
      scope TEXT NOT NULL, operation_id TEXT NOT NULL, request_hash TEXT NOT NULL,
      result_json TEXT NOT NULL, PRIMARY KEY(scope, operation_id)
    )
-- table coach_feedback_revisions
CREATE TABLE coach_feedback_revisions (
      scope TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL,
      available_at TEXT NOT NULL, payload_json TEXT NOT NULL,
      PRIMARY KEY(scope, id, revision)
    )
-- table coach_prediction_summaries
CREATE TABLE coach_prediction_summaries (
      scope TEXT NOT NULL, id TEXT NOT NULL, identity_hash TEXT NOT NULL,
      available_at TEXT NOT NULL, payload_json TEXT NOT NULL,
      PRIMARY KEY(scope, id)
    )
-- table daily_ability_snapshots
CREATE TABLE daily_ability_snapshots (
          id TEXT PRIMARY KEY,
          model_run_id TEXT NOT NULL REFERENCES model_runs(id) ON DELETE CASCADE,
          local_date TEXT NOT NULL,
          timezone_identifier TEXT NOT NULL,
          true_ability REAL,
          decay_points REAL NOT NULL DEFAULT 0,
          growth_velocity_per_week REAL,
          last_assessment_id TEXT REFERENCES ability_assessments(id),
          snapshot_status TEXT NOT NULL CHECK (snapshot_status IN ('calibrating', 'active', 'decay', 'no_data')),
          computed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), baseline_epoch_id TEXT,
          UNIQUE (model_run_id, local_date)
        )
-- table daily_training_metrics
CREATE TABLE daily_training_metrics (
          id TEXT PRIMARY KEY,
          training_metric_run_id TEXT NOT NULL REFERENCES training_metric_runs(id) ON DELETE CASCADE,
          local_date TEXT NOT NULL,
          timezone_identifier TEXT NOT NULL,
          distance_km REAL NOT NULL DEFAULT 0 CHECK (distance_km >= 0),
          duration_seconds REAL NOT NULL DEFAULT 0 CHECK (duration_seconds >= 0),
          workout_count INTEGER NOT NULL DEFAULT 0 CHECK (workout_count >= 0),
          daily_load REAL NOT NULL DEFAULT 0 CHECK (daily_load >= 0),
          current_7d_load REAL NOT NULL DEFAULT 0 CHECK (current_7d_load >= 0),
          previous_7d_load REAL NOT NULL DEFAULT 0 CHECK (previous_7d_load >= 0),
          acute_ewma REAL NOT NULL DEFAULT 0 CHECK (acute_ewma >= 0),
          chronic_ewma REAL NOT NULL DEFAULT 0 CHECK (chronic_ewma >= 0),
          load_ratio REAL,
          ramp_rate REAL,
          monotony REAL,
          strain REAL,
          recovery_evidence REAL CHECK (recovery_evidence BETWEEN 0 AND 1),
          history_days INTEGER NOT NULL DEFAULT 0 CHECK (history_days >= 0),
          load_workout_count INTEGER NOT NULL DEFAULT 0 CHECK (load_workout_count >= 0),
          training_status TEXT NOT NULL CHECK (training_status IN (
            'insufficient_data', 'recovery', 'maintaining',
            'effective_stimulus', 'high_load', 'attention'
          )),
          confidence REAL CHECK (confidence BETWEEN 0 AND 1),
          explanation_codes_json TEXT NOT NULL,
          explanation_json TEXT NOT NULL,
          computed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          UNIQUE (training_metric_run_id, local_date)
        )
-- table daily_zone_profiles
CREATE TABLE daily_zone_profiles (
          id TEXT PRIMARY KEY,
          training_metric_run_id TEXT NOT NULL REFERENCES training_metric_runs(id) ON DELETE CASCADE,
          local_date TEXT NOT NULL,
          timezone_identifier TEXT NOT NULL,
          effective_at TEXT NOT NULL,
          data_through_at TEXT,
          resting_heart_rate_bpm REAL NOT NULL CHECK (resting_heart_rate_bpm BETWEEN 35 AND 110),
          maximum_heart_rate_bpm REAL NOT NULL CHECK (maximum_heart_rate_bpm BETWEEN 120 AND 230),
          threshold_pace_seconds_per_km REAL CHECK (threshold_pace_seconds_per_km BETWEEN 150 AND 900),
          heart_rate_source TEXT NOT NULL CHECK (heart_rate_source IN ('automatic', 'manual', 'fallback', 'carried_forward')),
          pace_source TEXT NOT NULL CHECK (pace_source IN ('automatic', 'manual', 'fallback', 'carried_forward')),
          heart_rate_confidence REAL NOT NULL CHECK (heart_rate_confidence BETWEEN 0 AND 1),
          pace_confidence REAL NOT NULL CHECK (pace_confidence BETWEEN 0 AND 1),
          profile_status TEXT NOT NULL CHECK (profile_status IN ('stable', 'provisional', 'fallback')),
          heart_rate_bands_json TEXT NOT NULL,
          pace_bands_json TEXT NOT NULL,
          evidence_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          UNIQUE(training_metric_run_id, local_date)
        )
-- table entity_inventory
CREATE TABLE entity_inventory (
          entity_kind TEXT NOT NULL,
          entity_type TEXT NOT NULL,
          item_count INTEGER NOT NULL,
          first_at TEXT,
          last_at TEXT,
          details_json TEXT NOT NULL,
          PRIMARY KEY (entity_kind, entity_type)
        )
-- table feature_runs
CREATE TABLE feature_runs (
          id TEXT PRIMARY KEY,
          dataset_version TEXT NOT NULL,
          canonical_contract_version TEXT NOT NULL,
          feature_schema_version TEXT NOT NULL,
          feature_config_json TEXT NOT NULL,
          feature_config_hash TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          started_at TEXT,
          completed_at TEXT,
          failure_json TEXT, parent_feature_run_id TEXT REFERENCES feature_runs(id), reused_feature_count INTEGER NOT NULL DEFAULT 0 CHECK (reused_feature_count >= 0), recomputed_feature_count INTEGER NOT NULL DEFAULT 0 CHECK (recomputed_feature_count >= 0),
          UNIQUE (dataset_version, canonical_contract_version, feature_schema_version, feature_config_hash, created_at)
        )
-- table health_records
CREATE TABLE health_records (
          id TEXT PRIMARY KEY,
          type TEXT NOT NULL,
          source_name TEXT NOT NULL,
          source_category TEXT NOT NULL,
          source_version TEXT,
          device TEXT,
          unit TEXT,
          value_numeric REAL,
          value_text TEXT,
          start_at TEXT NOT NULL,
          end_at TEXT NOT NULL,
          created_at TEXT,
          metadata_json TEXT NOT NULL,
          raw_attributes_json TEXT NOT NULL
        , valid_from_generation INTEGER, available_at TEXT)
-- table healthkit_record_aliases
CREATE TABLE healthkit_record_aliases (
      alias_id TEXT NOT NULL,
      sample_type TEXT NOT NULL,
      sample_uuid TEXT NOT NULL,
      PRIMARY KEY (alias_id, sample_type, sample_uuid)
    )
-- table healthkit_record_facts
CREATE TABLE healthkit_record_facts (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      sample_type TEXT NOT NULL,
      sample_uuid TEXT NOT NULL,
      record_json TEXT NOT NULL,
      source_category TEXT NOT NULL,
      raw_attributes_json TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      UNIQUE (sample_type, sample_uuid)
    )
-- table healthkit_record_sources
CREATE TABLE healthkit_record_sources (
      sample_type TEXT NOT NULL,
      sample_uuid TEXT NOT NULL,
      record_id TEXT NOT NULL,
      PRIMARY KEY (sample_type, sample_uuid)
    )
-- table import_batch_files
CREATE TABLE import_batch_files (
          batch_id TEXT NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
          relative_path TEXT NOT NULL,
          size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
          modified_at_ms REAL,
          sha256 TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('new', 'changed', 'unchanged', 'removed')),
          PRIMARY KEY (batch_id, relative_path)
        )
-- table import_batch_partitions
CREATE TABLE import_batch_partitions (
      parent_batch_id TEXT NOT NULL,
      partition_contract TEXT NOT NULL,
      chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
      chunk_hash TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'committed')),
      receipt_json TEXT,
      PRIMARY KEY (parent_batch_id, partition_contract, chunk_index),
      UNIQUE (parent_batch_id, chunk_hash)
    )
-- table import_batches
CREATE TABLE import_batches (
          id TEXT PRIMARY KEY,
          source_sha256 TEXT,
          xml_sha256 TEXT NOT NULL,
          route_bundle_sha256 TEXT,
          status TEXT NOT NULL CHECK (status IN ('inspecting', 'running', 'unchanged', 'succeeded', 'failed', 'cancelled')),
          import_mode TEXT NOT NULL CHECK (import_mode IN ('unchanged', 'incremental', 'full')),
          previous_dataset_version TEXT,
          dataset_version TEXT,
          dirty_from_at TEXT,
          summary_json TEXT NOT NULL DEFAULT '{}',
          error_json TEXT,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          completed_at TEXT
        , raw_generation INTEGER, dependency_generation INTEGER, dependency_bumped INTEGER, analysis_dirty_plan_json TEXT)
-- table import_entity_changes
CREATE TABLE import_entity_changes (
          batch_id TEXT NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
          entity_kind TEXT NOT NULL,
          entity_id TEXT NOT NULL,
          change_type TEXT NOT NULL CHECK (change_type IN ('inserted', 'updated', 'removed', 'unchanged')),
          effective_at TEXT,
          content_hash TEXT, previous_effective_at TEXT, previous_end_at TEXT, previous_type TEXT,
          PRIMARY KEY (batch_id, entity_kind, entity_id)
        )
-- table import_entity_generations
CREATE TABLE import_entity_generations (
          entity_kind TEXT NOT NULL CHECK (entity_kind IN ('record', 'workout', 'activity_summary')),
          entity_id TEXT NOT NULL,
          generation TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          effective_at TEXT,
          PRIMARY KEY (entity_kind, entity_id)
        )
-- table import_entity_tombstones
CREATE TABLE import_entity_tombstones (
          entity_kind TEXT NOT NULL CHECK (entity_kind IN ('record', 'workout', 'activity_summary')),
          entity_id TEXT NOT NULL,
          source_identifier TEXT,
          batch_id TEXT,
          deleted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          PRIMARY KEY (entity_kind, entity_id)
        )
-- table import_fact_history
CREATE TABLE import_fact_history (
      entity_kind TEXT NOT NULL CHECK (entity_kind IN ('record', 'workout')),
      entity_id TEXT NOT NULL,
      valid_from_generation INTEGER NOT NULL CHECK (valid_from_generation >= 0),
      valid_to_generation INTEGER CHECK (valid_to_generation IS NULL OR valid_to_generation > valid_from_generation),
      content_hash TEXT NOT NULL,
      effective_at TEXT,
      available_at TEXT,
      payload_json TEXT NOT NULL,
      superseded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      PRIMARY KEY (entity_kind, entity_id, valid_from_generation)
    )
-- table import_generations
CREATE TABLE import_generations (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      raw_generation INTEGER NOT NULL CHECK (raw_generation >= 0),
      dependency_generation INTEGER NOT NULL CHECK (dependency_generation >= 0),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
-- table import_issues
CREATE TABLE import_issues (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          severity TEXT NOT NULL CHECK (severity IN ('warning', 'error')),
          code TEXT NOT NULL,
          object_id TEXT,
          message TEXT NOT NULL
        )
-- table import_manifest
CREATE TABLE import_manifest (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        )
-- table import_source_tombstones
CREATE TABLE "import_source_tombstones" (
      entity_kind TEXT NOT NULL CHECK (entity_kind IN ('workout', 'record')),
      source_identifier TEXT NOT NULL,
      batch_id TEXT,
      deleted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      PRIMARY KEY (entity_kind, source_identifier)
    )
-- table model_checkpoints
CREATE TABLE model_checkpoints (
          id TEXT PRIMARY KEY,
          model_run_id TEXT NOT NULL REFERENCES model_runs(id) ON DELETE CASCADE,
          sequence_number INTEGER NOT NULL CHECK (sequence_number >= 0),
          through_at TEXT NOT NULL,
          checkpoint_version TEXT NOT NULL,
          model_version TEXT NOT NULL,
          model_config_hash TEXT NOT NULL,
          feature_schema_version TEXT NOT NULL,
          feature_config_hash TEXT NOT NULL,
          timezone_identifier TEXT NOT NULL,
          state_json TEXT NOT NULL,
          state_hash TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          UNIQUE(model_run_id, sequence_number)
        )
-- table model_domain_snapshots
CREATE TABLE model_domain_snapshots (
      model_run_id TEXT NOT NULL REFERENCES model_runs(id) ON DELETE CASCADE,
      domain TEXT NOT NULL,
      snapshot_key TEXT NOT NULL,
      as_of TEXT NOT NULL,
      payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
      payload_hash TEXT NOT NULL,
      PRIMARY KEY(model_run_id, domain, snapshot_key)
    )
-- table model_release_bundles
CREATE TABLE model_release_bundles (
      model_run_id TEXT PRIMARY KEY REFERENCES model_runs(id) ON DELETE RESTRICT,
      base_model_run_id TEXT,
      dataset_version TEXT NOT NULL,
      snapshot_hash TEXT NOT NULL,
      evaluation_json TEXT NOT NULL CHECK(json_valid(evaluation_json)),
      status TEXT NOT NULL CHECK(status IN ('passed','failed','not_evaluable')),
      created_at TEXT NOT NULL,
      activated_at TEXT
    )
-- table model_release_refusals
CREATE TABLE model_release_refusals (
      id TEXT PRIMARY KEY,
      model_run_id TEXT NOT NULL REFERENCES model_runs(id) ON DELETE CASCADE,
      -- 只登记**已接线**的阶段。预测侧的两个拒绝阶段（activation_compatibility /
      -- artifact_boundary）还没接，等接的时候再加法扩宽 CHECK，不留"允许但永不写入"的值。
      stage TEXT NOT NULL CHECK (stage IN ('release_gate')),
      reason_codes_json TEXT NOT NULL CHECK(json_valid(reason_codes_json)),
      detail TEXT NOT NULL,
      detected_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
-- table model_runs
CREATE TABLE model_runs (
          id TEXT PRIMARY KEY,
          feature_run_id TEXT NOT NULL REFERENCES feature_runs(id),
          dataset_version TEXT NOT NULL,
          model_version TEXT NOT NULL,
          model_config_json TEXT NOT NULL,
          model_config_hash TEXT NOT NULL,
          evaluated_at TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          started_at TEXT,
          completed_at TEXT,
          summary_json TEXT,
          failure_json TEXT
        , parent_model_run_id TEXT REFERENCES model_runs(id), reused_assessment_count INTEGER NOT NULL DEFAULT 0 CHECK (reused_assessment_count >= 0), engine_version TEXT)
-- table model_v2_runs
CREATE TABLE model_v2_runs (
      model_run_id TEXT PRIMARY KEY REFERENCES model_runs(id) ON DELETE CASCADE,
      engine_version TEXT NOT NULL,
      config_version TEXT NOT NULL,
      lineage_json TEXT NOT NULL CHECK(json_valid(lineage_json)),
      lineage_hash TEXT NOT NULL
    )
-- table model_validation_gates
CREATE TABLE model_validation_gates (
      id TEXT PRIMARY KEY,
      candidate_model_run_id TEXT NOT NULL REFERENCES model_runs(id) ON DELETE CASCADE,
      base_model_run_id TEXT REFERENCES model_runs(id) ON DELETE SET NULL,
      gate_version TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('passed', 'failed', 'not_evaluable', 'skipped')),
      metrics_json TEXT NOT NULL,
      thresholds_json TEXT NOT NULL,
      failure_reasons_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      UNIQUE(candidate_model_run_id, gate_version)
    )
-- table performance_entries
CREATE TABLE performance_entries (
      id TEXT PRIMARY KEY,
      local_date TEXT NOT NULL,
      distance TEXT NOT NULL CHECK(distance IN ('five_k', 'ten_k', 'half_marathon')),
      duration_seconds REAL NOT NULL CHECK(duration_seconds > 0),
      source TEXT NOT NULL CHECK(source IN ('manual')),
      note TEXT,
      recorded_at TEXT NOT NULL,
      revoked_at TEXT,
      revision INTEGER NOT NULL CHECK(revision >= 1)
    , training_session_id TEXT, observed_at TEXT, completed_at TEXT)
-- table prediction_calibration_artifacts
CREATE TABLE prediction_calibration_artifacts (
      id TEXT PRIMARY KEY,
      predictor_version TEXT NOT NULL,
      baseline_hash TEXT NOT NULL,
      distance TEXT NOT NULL CHECK(distance IN ('five_k','ten_k','half_marathon')),
      available_at TEXT NOT NULL,
      artifact_json TEXT NOT NULL CHECK(json_valid(artifact_json)),
      artifact_hash TEXT NOT NULL,
      evaluation_json TEXT NOT NULL CHECK(json_valid(evaluation_json)),
      status TEXT NOT NULL CHECK(status IN ('passed','failed','not_evaluable'))
    )
-- table prediction_label_state
CREATE TABLE prediction_label_state (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
      revision INTEGER NOT NULL
    )
-- table prediction_model_events
CREATE TABLE prediction_model_events (
          id TEXT PRIMARY KEY,
          prediction_model_run_id TEXT NOT NULL
            REFERENCES prediction_model_runs(id) ON DELETE CASCADE,
          phase TEXT NOT NULL,
          progress_current INTEGER NOT NULL DEFAULT 0,
          progress_total INTEGER NOT NULL DEFAULT 0,
          message TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        )
-- table prediction_model_runs
CREATE TABLE prediction_model_runs (
          id TEXT PRIMARY KEY,
          algorithm TEXT NOT NULL CHECK (algorithm = 'catboost'),
          model_version TEXT NOT NULL,
          feature_schema_version TEXT NOT NULL,
          feature_schema_hash TEXT,
          training_data_hash TEXT,
          training_data_through_at TEXT NOT NULL,
          hyperparameters_json TEXT NOT NULL,
          request_json TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN (
            'queued', 'running', 'validating', 'succeeded', 'rejected', 'failed', 'cancelled'
          )),
          label_count INTEGER NOT NULL DEFAULT 0,
          label_count_by_distance_json TEXT NOT NULL DEFAULT '{}',
          holdout_prediction_count INTEGER NOT NULL DEFAULT 0,
          metrics_json TEXT,
          supported_distances_json TEXT NOT NULL DEFAULT '[]',
          artifact_path TEXT,
          artifact_sha256 TEXT,
          cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0, 1)),
          failure_json TEXT,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          started_at TEXT,
          completed_at TEXT,
          activated_at TEXT
        , worker_token TEXT, heartbeat_at TEXT, attempt_count INTEGER NOT NULL DEFAULT 0
          CHECK (attempt_count >= 0), ability_baseline_hash TEXT)
-- table privacy_zone_revisions
CREATE TABLE privacy_zone_revisions (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
      revision INTEGER NOT NULL CHECK(revision >= 0),
      updated_at TEXT NOT NULL
    )
-- table privacy_zones
CREATE TABLE privacy_zones (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      center_latitude REAL NOT NULL CHECK(center_latitude BETWEEN -90 AND 90),
      center_longitude REAL NOT NULL CHECK(center_longitude BETWEEN -180 AND 180),
      radius_meters REAL NOT NULL CHECK(radius_meters > 0 AND radius_meters <= 5000),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
-- table profile
CREATE TABLE profile (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          attributes_json TEXT NOT NULL
        )
-- table recompute_job_events
CREATE TABLE recompute_job_events (
          id TEXT PRIMARY KEY,
          job_id TEXT NOT NULL REFERENCES recompute_jobs(id) ON DELETE CASCADE,
          phase TEXT NOT NULL,
          progress_current INTEGER NOT NULL,
          progress_total INTEGER NOT NULL,
          message TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        )
-- table recompute_jobs
CREATE TABLE recompute_jobs (
          id TEXT PRIMARY KEY,
          job_type TEXT NOT NULL CHECK (job_type IN ('import', 'full_recompute', 'snapshot_refresh')),
          status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
          dataset_version TEXT,
          feature_run_id TEXT REFERENCES feature_runs(id),
          model_run_id TEXT REFERENCES model_runs(id),
          request_json TEXT NOT NULL,
          progress_phase TEXT NOT NULL,
          progress_current INTEGER NOT NULL DEFAULT 0,
          progress_total INTEGER NOT NULL DEFAULT 0,
          cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0, 1)),
          error_json TEXT,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          started_at TEXT,
          completed_at TEXT
        , target_raw_generation INTEGER, target_dependency_generation INTEGER, expected_incumbent_release_id TEXT, dirty_json TEXT, attempts INTEGER NOT NULL DEFAULT 0)
-- table recompute_validations
CREATE TABLE recompute_validations (
          id TEXT PRIMARY KEY,
          job_id TEXT NOT NULL REFERENCES recompute_jobs(id) ON DELETE CASCADE,
          candidate_model_run_id TEXT NOT NULL REFERENCES model_runs(id) ON DELETE CASCADE,
          reference_model_run_id TEXT NOT NULL REFERENCES model_runs(id) ON DELETE CASCADE,
          mode TEXT NOT NULL CHECK (mode = 'shadow'),
          status TEXT NOT NULL CHECK (status IN ('matched', 'mismatched')),
          hashes_json TEXT NOT NULL,
          mismatch_json TEXT,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        )
-- table route_file_fingerprints
CREATE TABLE route_file_fingerprints (
          relative_path TEXT PRIMARY KEY,
          size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
          modified_at_ms REAL NOT NULL,
          sha256 TEXT NOT NULL,
          route_id TEXT NOT NULL,
          point_count INTEGER NOT NULL DEFAULT 0 CHECK (point_count >= 0),
          imported_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        )
-- table route_points
CREATE TABLE route_points (
          route_id TEXT NOT NULL REFERENCES workout_routes(id) ON DELETE CASCADE,
          sequence INTEGER NOT NULL,
          timestamp TEXT,
          latitude REAL NOT NULL,
          longitude REAL NOT NULL,
          elevation_meters REAL,
          speed_mps REAL,
          course_degrees REAL,
          horizontal_accuracy_meters REAL,
          vertical_accuracy_meters REAL,
          PRIMARY KEY (route_id, sequence)
        )
-- table route_version_points
CREATE TABLE route_version_points (
      route_version_id TEXT NOT NULL REFERENCES route_versions(id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL,
      timestamp TEXT,
      latitude REAL NOT NULL,
      longitude REAL NOT NULL,
      elevation_meters REAL,
      speed_mps REAL,
      course_degrees REAL,
      horizontal_accuracy_meters REAL,
      vertical_accuracy_meters REAL,
      PRIMARY KEY (route_version_id, sequence)
    )
-- table route_versions
CREATE TABLE route_versions (
      id TEXT PRIMARY KEY,
      route_id TEXT NOT NULL REFERENCES workout_routes(id) ON DELETE CASCADE,
      content_sha256 TEXT NOT NULL,
      point_count INTEGER NOT NULL CHECK (point_count >= 0),
      status TEXT NOT NULL CHECK (status IN ('pending', 'complete', 'rejected')),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      completed_at TEXT,
      UNIQUE (route_id, content_sha256)
    )
-- table schema_migrations
CREATE TABLE schema_migrations (
          version INTEGER PRIMARY KEY,
          name TEXT,
          checksum TEXT,
          applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        )
-- table training_metric_checkpoints
CREATE TABLE training_metric_checkpoints (
      id TEXT PRIMARY KEY,
      training_metric_run_id TEXT NOT NULL REFERENCES training_metric_runs(id) ON DELETE CASCADE,
      checkpoint_version TEXT NOT NULL,
      load_algorithm_version TEXT NOT NULL,
      zone_algorithm_version TEXT NOT NULL,
      daily_algorithm_version TEXT NOT NULL,
      config_hash TEXT NOT NULL,
      zone_settings_digest TEXT NOT NULL,
      override_digest TEXT NOT NULL,
      input_binding_digest TEXT NOT NULL,
      timezone_identifier TEXT NOT NULL,
      through_local_date TEXT NOT NULL,
      through_at TEXT NOT NULL,
      prefix_from_local_date TEXT,
      prefix_through_local_date TEXT,
      state_json TEXT NOT NULL,
      state_hash TEXT NOT NULL,
      counters_json TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    , prefix_compat_digest TEXT)
-- table training_metric_runs
CREATE TABLE training_metric_runs (
          id TEXT PRIMARY KEY,
          model_run_id TEXT NOT NULL UNIQUE REFERENCES model_runs(id) ON DELETE CASCADE,
          algorithm_version TEXT NOT NULL,
          config_json TEXT NOT NULL,
          config_hash TEXT NOT NULL,
          timezone_identifier TEXT NOT NULL,
          evaluated_at TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'cancelled')),
          summary_json TEXT,
          failure_json TEXT,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          started_at TEXT,
          completed_at TEXT
        )
-- table training_sessions
CREATE TABLE training_sessions (
          id TEXT PRIMARY KEY,
          activity_type TEXT NOT NULL,
          anchor_start_at TEXT NOT NULL,
          anchor_end_at TEXT NOT NULL,
          anchor_distance_km REAL,
          canonical_workout_id TEXT REFERENCES workouts(id) ON DELETE SET NULL,
          status TEXT NOT NULL CHECK (status IN ('active', 'inactive', 'ambiguous')),
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        )
-- table training_zone_profile_settings
CREATE TABLE training_zone_profile_settings (
          id TEXT PRIMARY KEY,
          revision INTEGER NOT NULL UNIQUE CHECK (revision >= 1),
          effective_from_local_date TEXT NOT NULL,
          resting_mode TEXT NOT NULL CHECK (resting_mode IN ('auto', 'manual')),
          resting_value_bpm REAL CHECK (resting_value_bpm BETWEEN 35 AND 110),
          maximum_mode TEXT NOT NULL CHECK (maximum_mode IN ('auto', 'manual')),
          maximum_value_bpm REAL CHECK (maximum_value_bpm BETWEEN 120 AND 230),
          threshold_pace_mode TEXT NOT NULL CHECK (threshold_pace_mode IN ('auto', 'manual')),
          threshold_pace_seconds_per_km REAL CHECK (threshold_pace_seconds_per_km BETWEEN 150 AND 900),
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        )
-- table workout_events
CREATE TABLE workout_events (
          workout_id TEXT NOT NULL REFERENCES workouts(id) ON DELETE CASCADE,
          ordinal INTEGER NOT NULL,
          type TEXT NOT NULL,
          event_at TEXT,
          duration_seconds REAL,
          metadata_json TEXT NOT NULL,
          PRIMARY KEY (workout_id, ordinal)
        )
-- table workout_features
CREATE TABLE workout_features (
          id TEXT PRIMARY KEY,
          feature_run_id TEXT NOT NULL REFERENCES feature_runs(id) ON DELETE CASCADE,
          training_session_id TEXT NOT NULL REFERENCES training_sessions(id),
          canonical_workout_id TEXT NOT NULL,
          workout_start_at TEXT NOT NULL,
          duration_seconds REAL NOT NULL,
          distance_km REAL,
          average_speed_mps REAL,
          average_heart_rate_bpm REAL,
          heart_rate_sample_count INTEGER NOT NULL DEFAULT 0,
          heart_rate_coverage REAL,
          route_point_count INTEGER NOT NULL DEFAULT 0,
          route_quality REAL,
          source_confidence REAL NOT NULL,
          session_type TEXT NOT NULL,
          session_type_source TEXT NOT NULL CHECK (session_type_source IN ('auto', 'override')),
          eligibility_status TEXT NOT NULL CHECK (eligibility_status IN ('eligible', 'trial', 'excluded')),
          quality_score REAL NOT NULL,
          missing_reasons_json TEXT NOT NULL,
          features_json TEXT NOT NULL,
          provenance_json TEXT NOT NULL,
          computed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          UNIQUE (feature_run_id, training_session_id)
        )
-- table workout_group_members
CREATE TABLE workout_group_members (
          group_id TEXT NOT NULL REFERENCES workout_groups(id) ON DELETE CASCADE,
          workout_id TEXT NOT NULL REFERENCES workouts(id) ON DELETE CASCADE,
          is_canonical INTEGER NOT NULL CHECK (is_canonical IN (0, 1)),
          canonical_rank REAL NOT NULL,
          PRIMARY KEY (group_id, workout_id)
        )
-- table workout_groups
CREATE TABLE workout_groups (
          id TEXT PRIMARY KEY,
          activity_type TEXT NOT NULL,
          canonical_workout_id TEXT NOT NULL REFERENCES workouts(id),
          member_count INTEGER NOT NULL,
          reason TEXT NOT NULL
        , training_session_id TEXT REFERENCES training_sessions(id) ON DELETE SET NULL)
-- table workout_overrides
CREATE TABLE workout_overrides (
          id TEXT PRIMARY KEY,
          training_session_id TEXT NOT NULL REFERENCES training_sessions(id),
          revision INTEGER NOT NULL,
          eligibility_override TEXT CHECK (eligibility_override IN ('include', 'exclude')),
          session_type TEXT,
          rpe INTEGER CHECK (rpe BETWEEN 1 AND 10),
          condition_tags_json TEXT NOT NULL DEFAULT '[]',
          note TEXT,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), performance_protocol TEXT CHECK (
            performance_protocol IN (
              'five_k_time_trial',
              'ten_k_time_trial',
              'thirty_min_threshold',
              'half_marathon_race',
              'other_race'
            )
          ), statistics_participation TEXT CHECK (
            statistics_participation IN ('include', 'exclude')
          ),
          UNIQUE (training_session_id, revision)
        )
-- table workout_routes
CREATE TABLE workout_routes (
          id TEXT PRIMARY KEY,
          workout_id TEXT REFERENCES workouts(id) ON DELETE CASCADE,
          source_name TEXT,
          source_category TEXT NOT NULL,
          source_version TEXT,
          start_at TEXT,
          end_at TEXT,
          created_at TEXT,
          relative_path TEXT UNIQUE,
          metadata_json TEXT NOT NULL,
          point_count INTEGER NOT NULL DEFAULT 0,
          file_status TEXT NOT NULL DEFAULT 'pending'
        , published_route_version_id TEXT REFERENCES route_versions(id))
-- table workout_statistics
CREATE TABLE workout_statistics (
          workout_id TEXT NOT NULL REFERENCES workouts(id) ON DELETE CASCADE,
          ordinal INTEGER NOT NULL,
          type TEXT NOT NULL,
          start_at TEXT,
          end_at TEXT,
          unit TEXT,
          sum_value REAL,
          average_value REAL,
          minimum_value REAL,
          maximum_value REAL,
          PRIMARY KEY (workout_id, ordinal)
        )
-- table workout_training_loads
CREATE TABLE workout_training_loads (
          id TEXT PRIMARY KEY,
          training_metric_run_id TEXT NOT NULL REFERENCES training_metric_runs(id) ON DELETE CASCADE,
          training_session_id TEXT NOT NULL REFERENCES training_sessions(id),
          feature_id TEXT REFERENCES workout_features(id),
          local_date TEXT NOT NULL,
          timezone_identifier TEXT NOT NULL,
          distance_km REAL,
          duration_seconds REAL NOT NULL CHECK (duration_seconds >= 0),
          training_load REAL NOT NULL CHECK (training_load >= 0),
          intensity REAL NOT NULL CHECK (intensity BETWEEN 0 AND 1),
          load_source TEXT NOT NULL CHECK (load_source IN (
            'composite', 'heart_rate_series', 'average_heart_rate', 'rpe', 'session_type'
          )),
          confidence REAL NOT NULL CHECK (confidence BETWEEN 0 AND 1),
          heart_rate_coverage REAL,
          average_heart_rate_bpm REAL,
          elevation_gain_meters REAL CHECK (elevation_gain_meters >= 0),
          rpe INTEGER CHECK (rpe BETWEEN 1 AND 10),
          session_type TEXT NOT NULL,
          explanation_codes_json TEXT NOT NULL,
          provenance_json TEXT NOT NULL,
          computed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          zone_profile_id TEXT REFERENCES daily_zone_profiles(id),
          stimulus_type TEXT NOT NULL DEFAULT 'unclassified',
          raw_hrr_trimp REAL CHECK (raw_hrr_trimp >= 0),
          internal_load REAL CHECK (internal_load >= 0),
          pace_load REAL CHECK (pace_load >= 0),
          distance_reference_meters REAL CHECK (distance_reference_meters > 0),
          distance_exposure_ratio REAL CHECK (distance_exposure_ratio >= 0),
          distance_factor REAL NOT NULL DEFAULT 1 CHECK (distance_factor BETWEEN 1 AND 1.15),
          heart_rate_load_confidence REAL NOT NULL DEFAULT 0 CHECK (heart_rate_load_confidence BETWEEN 0 AND 1),
          pace_load_confidence REAL NOT NULL DEFAULT 0 CHECK (pace_load_confidence BETWEEN 0 AND 1),
          UNIQUE (training_metric_run_id, training_session_id)
        )
-- table workout_zone_summaries
CREATE TABLE workout_zone_summaries (
          id TEXT PRIMARY KEY,
          training_metric_run_id TEXT NOT NULL REFERENCES training_metric_runs(id) ON DELETE CASCADE,
          training_session_id TEXT NOT NULL REFERENCES training_sessions(id),
          feature_id TEXT REFERENCES workout_features(id),
          zone_profile_id TEXT NOT NULL REFERENCES daily_zone_profiles(id),
          stimulus_type TEXT NOT NULL CHECK (stimulus_type IN (
            'recovery', 'aerobic_base', 'marathon_pace', 'lactate_threshold',
            'vo2max', 'anaerobic_endurance', 'unclassified'
          )),
          secondary_stimulus_types_json TEXT NOT NULL,
          stimulus_confidence REAL NOT NULL CHECK (stimulus_confidence BETWEEN 0 AND 1),
          heart_rate_coverage REAL NOT NULL CHECK (heart_rate_coverage BETWEEN 0 AND 1),
          pace_coverage REAL NOT NULL CHECK (pace_coverage BETWEEN 0 AND 1),
          heart_rate_exposure_json TEXT NOT NULL,
          pace_exposure_json TEXT NOT NULL,
          stimulus_scores_json TEXT NOT NULL,
          explanation_codes_json TEXT NOT NULL,
          computed_at TEXT NOT NULL,
          UNIQUE(training_metric_run_id, training_session_id)
        )
-- table workouts
CREATE TABLE workouts (
          id TEXT PRIMARY KEY,
          activity_type TEXT NOT NULL,
          source_name TEXT NOT NULL,
          source_category TEXT NOT NULL,
          source_version TEXT,
          device TEXT,
          start_at TEXT NOT NULL,
          end_at TEXT NOT NULL,
          created_at TEXT,
          duration_seconds REAL NOT NULL,
          indoor INTEGER CHECK (indoor IN (0, 1)),
          metadata_json TEXT NOT NULL,
          raw_attributes_json TEXT NOT NULL,
          canonical_group_id TEXT,
          is_canonical INTEGER NOT NULL DEFAULT 0 CHECK (is_canonical IN (0, 1))
        , valid_from_generation INTEGER, deleted_at TEXT)
-- view active_ability_assessments
CREATE VIEW active_ability_assessments AS
        SELECT assessment.*
        FROM ability_assessments assessment
        JOIN model_runs model ON model.id = assessment.model_run_id
        JOIN active_model_run active ON active.model_run_id = model.id
        WHERE model.status = 'succeeded'
-- view active_daily_ability_snapshots
CREATE VIEW active_daily_ability_snapshots AS
        SELECT snapshot.*
        FROM daily_ability_snapshots snapshot
        JOIN model_runs model ON model.id = snapshot.model_run_id
        JOIN active_model_run active ON active.model_run_id = model.id
        WHERE model.status = 'succeeded'
-- view active_daily_training_metrics
CREATE VIEW active_daily_training_metrics AS
        SELECT metric.*
        FROM daily_training_metrics metric
        JOIN training_metric_runs metric_run ON metric_run.id = metric.training_metric_run_id
        JOIN model_runs model ON model.id = metric_run.model_run_id
        JOIN active_model_run active ON active.model_run_id = model.id
        WHERE model.status = 'succeeded' AND metric_run.status = 'succeeded'
-- view active_daily_zone_profiles
CREATE VIEW active_daily_zone_profiles AS
        SELECT profile.*
        FROM daily_zone_profiles profile
        JOIN training_metric_runs metric_run ON metric_run.id = profile.training_metric_run_id
        JOIN active_model_run active ON active.model_run_id = metric_run.model_run_id
        WHERE metric_run.status = 'succeeded'
-- view active_workout_training_loads
CREATE VIEW active_workout_training_loads AS
        SELECT load.*
        FROM workout_training_loads load
        JOIN training_metric_runs metric_run ON metric_run.id = load.training_metric_run_id
        JOIN active_model_run active ON active.model_run_id = metric_run.model_run_id
        WHERE metric_run.status = 'succeeded'
-- view active_workout_zone_summaries
CREATE VIEW active_workout_zone_summaries AS
        SELECT summary.*
        FROM workout_zone_summaries summary
        JOIN training_metric_runs metric_run ON metric_run.id = summary.training_metric_run_id
        JOIN active_model_run active ON active.model_run_id = metric_run.model_run_id
        WHERE metric_run.status = 'succeeded'
-- view effective_workout_overrides
CREATE VIEW effective_workout_overrides AS
        SELECT
          id,
          training_session_id,
          revision,
          eligibility_override,
          statistics_participation,
          session_type,
          performance_protocol,
          rpe,
          condition_tags_json,
          note,
          created_at
        FROM (
          SELECT
            workout_overrides.*,
            ROW_NUMBER() OVER (
              PARTITION BY training_session_id
              ORDER BY revision DESC
            ) AS row_number
          FROM workout_overrides
        )
        WHERE row_number = 1
-- view readable_route_points
CREATE VIEW readable_route_points AS
      SELECT route.id AS route_id,
             point.sequence AS sequence,
             point.timestamp AS timestamp,
             point.latitude AS latitude,
             point.longitude AS longitude,
             point.elevation_meters AS elevation_meters,
             point.speed_mps AS speed_mps,
             point.course_degrees AS course_degrees,
             point.horizontal_accuracy_meters AS horizontal_accuracy_meters,
             point.vertical_accuracy_meters AS vertical_accuracy_meters
        FROM workout_routes route
        JOIN route_version_points point ON point.route_version_id = route.published_route_version_id
       WHERE route.file_status = 'imported' AND route.point_count > 0
      UNION ALL
      SELECT point.route_id AS route_id,
             point.sequence AS sequence,
             point.timestamp AS timestamp,
             point.latitude AS latitude,
             point.longitude AS longitude,
             point.elevation_meters AS elevation_meters,
             point.speed_mps AS speed_mps,
             point.course_degrees AS course_degrees,
             point.horizontal_accuracy_meters AS horizontal_accuracy_meters,
             point.vertical_accuracy_meters AS vertical_accuracy_meters
        FROM route_points point
        JOIN workout_routes route ON route.id = point.route_id
       WHERE route.published_route_version_id IS NULL
         AND route.file_status = 'imported' AND route.point_count > 0
=== control ===
-- table mobile_coach_loop_receipts
CREATE TABLE mobile_coach_loop_receipts (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL,
        operation_id TEXT NOT NULL, payload_json TEXT NOT NULL,
        UNIQUE(scope,operation_id)
      )
-- table mobile_control_schema
CREATE TABLE mobile_control_schema (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      )
-- table mobile_goals
CREATE TABLE mobile_goals (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        revision INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
-- table mobile_goals_history
CREATE TABLE mobile_goals_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        revision INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        changed_at TEXT NOT NULL
      )
-- table mobile_plan_operations
CREATE TABLE mobile_plan_operations (
        scope TEXT NOT NULL, operation_id TEXT NOT NULL, request_digest TEXT NOT NULL,
        result_json TEXT, expires_at TEXT NOT NULL, PRIMARY KEY(scope, operation_id)
      )
-- table mobile_plan_pushes
CREATE TABLE mobile_plan_pushes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        local_date TEXT NOT NULL,
        revision INTEGER NOT NULL,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        pushed_at TEXT NOT NULL
      , scope_key TEXT, idempotency_key TEXT, workout_id TEXT, scheduled_at TEXT)
-- table mobile_publication_guard
CREATE TABLE mobile_publication_guard (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      epoch INTEGER NOT NULL DEFAULT 0,
      pending_since TEXT
    )
-- table mobile_training_migration_audit
CREATE TABLE mobile_training_migration_audit (
      scope TEXT NOT NULL,
      migration_version INTEGER NOT NULL,
      source_digest TEXT NOT NULL,
      result_digest TEXT NOT NULL,
      status TEXT NOT NULL,
      payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
      created_at TEXT NOT NULL,
      PRIMARY KEY (scope, migration_version)
    )
-- table mobile_training_state
CREATE TABLE mobile_training_state (
      scope TEXT PRIMARY KEY,
      revision INTEGER NOT NULL CHECK (revision >= 0),
      payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
      updated_at TEXT NOT NULL
    )
-- table mobile_training_state_history
CREATE TABLE mobile_training_state_history (
      scope TEXT NOT NULL,
      revision INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
      changed_at TEXT NOT NULL,
      PRIMARY KEY (scope, revision)
    )
=== runtime ===
-- table import_jobs
CREATE TABLE import_jobs (
          sequence_number INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
          source_id TEXT, status TEXT NOT NULL, phase TEXT NOT NULL, message TEXT NOT NULL,
          created_at TEXT NOT NULL, completed_at TEXT, error TEXT,
          input_path TEXT NOT NULL, progress REAL, summary_json TEXT
        , removal_guard_json TEXT, performance_json TEXT, execution_json TEXT)
-- table import_publication_supersessions
CREATE TABLE import_publication_supersessions (
        id TEXT PRIMARY KEY, restored_epoch TEXT NOT NULL, reason TEXT NOT NULL, superseded_at TEXT NOT NULL)
-- table import_publications
CREATE TABLE import_publications (id TEXT PRIMARY KEY, payload TEXT NOT NULL)
-- table import_scope_evidence
CREATE TABLE import_scope_evidence (
          scope TEXT PRIMARY KEY,
          state TEXT NOT NULL,
          first_empty_epoch INTEGER,
          pristine_at TEXT,
          permit_source TEXT,
          permit_revoked_at TEXT,
          writer_entered_at TEXT,
          dataset_established_at TEXT,
          detail TEXT
        )
-- table import_sources
CREATE TABLE import_sources (
          id TEXT PRIMARY KEY, kind TEXT NOT NULL, display_name TEXT NOT NULL,
          input_path TEXT NOT NULL, original_path TEXT NOT NULL, source_sha256 TEXT,
          idempotency_key TEXT UNIQUE,
          export_file_name TEXT NOT NULL, export_bytes INTEGER NOT NULL,
          route_file_count INTEGER NOT NULL, modified_at TEXT NOT NULL,
          created_at TEXT NOT NULL, last_used_at TEXT
        , archive_sha256 TEXT)
-- table mutation_commands
CREATE TABLE mutation_commands (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
      scope TEXT NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL
    )
-- table runtime_meta
CREATE TABLE runtime_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)
-- table scope_abandonments
CREATE TABLE scope_abandonments (
          id TEXT PRIMARY KEY,
          old_scope TEXT NOT NULL,
          new_scope TEXT NOT NULL,
          old_epoch TEXT NOT NULL,
          new_epoch TEXT NOT NULL,
          operator TEXT NOT NULL,
          reason TEXT NOT NULL,
          created_at TEXT NOT NULL
        )
