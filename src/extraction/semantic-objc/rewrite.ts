import type { SqliteDatabase } from '../../db/sqlite-adapter';
import type { SemanticObjcDeltaPlan } from './delta';
import { markSemanticObjcFresh, markSemanticObjcStale } from './state';

export interface SemanticObjcRewriteSummary {
  mode: 'rewritten' | 'stale';
  staleReason?: string;
  nodesCleared: number;
  edgesDeleted: number;
  ownershipRowsDeleted: number;
}

export function applySemanticObjcDeltaRewrite(
  db: SqliteDatabase,
  plan: SemanticObjcDeltaPlan,
  now = Date.now()
): SemanticObjcRewriteSummary {
  db.exec('BEGIN');
  try {
    const summary = applySemanticObjcDeltaRewriteInTransaction(db, plan, now);
    db.exec('COMMIT');
    return summary;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function applySemanticObjcDeltaRewriteInTransaction(
  db: SqliteDatabase,
  plan: SemanticObjcDeltaPlan,
  now: number
): SemanticObjcRewriteSummary {
  if (plan.mode !== 'delta') {
    const reason = plan.reason ?? 'semantic-delta-unsafe';
    markSemanticObjcStale(db, reason, now);
    return {
      mode: 'stale',
      staleReason: reason,
      nodesCleared: 0,
      edgesDeleted: 0,
      ownershipRowsDeleted: 0,
    };
  }

  const affectedUnitIds = [...new Set([...plan.changedUnitIds, ...plan.removedUnitIds])];
  if (affectedUnitIds.length === 0) {
    markSemanticObjcFresh(db, now);
    return { mode: 'rewritten', nodesCleared: 0, edgesDeleted: 0, ownershipRowsDeleted: 0 };
  }

  const affectedNodes = exclusivelyOwnedNodesForUnits(db, affectedUnitIds);
  const nodesCleared = clearNodeUsrs(db, affectedNodes);
  const edgesDeleted = deleteSemanticEdges(db, affectedNodes);
  const ownershipRowsDeleted = deleteOwnershipRows(db, affectedUnitIds, affectedNodes);
  markSemanticObjcFresh(db, now);

  return {
    mode: 'rewritten',
    nodesCleared,
    edgesDeleted,
    ownershipRowsDeleted,
  };
}

function exclusivelyOwnedNodesForUnits(db: SqliteDatabase, unitIds: string[]): string[] {
  const unitValues = sqlValues(unitIds);
  const rows = db.prepare(`
    SELECT node_id
    FROM semantic_objc_node_ownership
    GROUP BY node_id
    HAVING
      SUM(CASE WHEN unit_id NOT IN (${unitValues.placeholders}) THEN 1 ELSE 0 END) = 0
      AND SUM(CASE WHEN ownership != 'exclusive' THEN 1 ELSE 0 END) = 0
  `).all(...unitValues.values) as Array<{ node_id: string }>;
  return rows.map((row) => row.node_id);
}

function clearNodeUsrs(db: SqliteDatabase, nodeIds: string[]): number {
  if (nodeIds.length === 0) return 0;
  const values = sqlValues(nodeIds);
  return db.prepare(`UPDATE nodes SET usr = NULL WHERE id IN (${values.placeholders})`).run(
    ...values.values
  ).changes;
}

function deleteSemanticEdges(db: SqliteDatabase, nodeIds: string[]): number {
  if (nodeIds.length === 0) return 0;
  const values = sqlValues(nodeIds);
  return db.prepare(`
    DELETE FROM edges
    WHERE provenance = 'semantic-objc'
      AND (source IN (${values.placeholders}) OR target IN (${values.placeholders}))
  `).run(...values.values, ...values.values).changes;
}

function deleteOwnershipRows(db: SqliteDatabase, unitIds: string[], nodeIds: string[]): number {
  if (nodeIds.length === 0) return 0;
  const unitValues = sqlValues(unitIds);
  const nodeValues = sqlValues(nodeIds);
  return db.prepare(`
    DELETE FROM semantic_objc_node_ownership
    WHERE unit_id IN (${unitValues.placeholders})
      AND node_id IN (${nodeValues.placeholders})
  `).run(...unitValues.values, ...nodeValues.values).changes;
}

function sqlValues(values: string[]): { placeholders: string; values: string[] } {
  return {
    placeholders: values.map(() => '?').join(', '),
    values,
  };
}
