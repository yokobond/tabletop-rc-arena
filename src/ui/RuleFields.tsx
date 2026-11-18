import { applyArenaEdit } from '../game/arena';
import { TABLE_SCALES } from '../game/constants';
import type { CpuDifficulty, GameMode, StageId } from '../game/types';
import { canEditArena, chooseStage, setTableScale, updateSettings, useGame } from '../runtime/store';
import { Segmented } from './controls';

const MODES: { value: GameMode; label: string }[] = [
  { value: 'pvp', label: '1P vs 2P' },
  { value: 'cpu', label: '1P vs CPU' },
];
const DIFFICULTIES: { value: CpuDifficulty; label: string }[] = [
  { value: 'easy', label: 'Easy' },
  { value: 'normal', label: 'Normal' },
  { value: 'hard', label: 'Hard' },
];
const STAGES: { value: StageId; label: string }[] = [
  { value: 'standard', label: 'スタンダード机' },
  { value: 'ramps', label: 'ジャンプリング' },
  { value: 'sumo', label: 'シンプル土俵' },
  // The arena made in the editor and saved on this device.
  { value: 'custom', label: 'カスタム' },
];
const TARGETS = [
  { value: 3, label: '3点先取' },
  { value: 5, label: '5点先取' },
  { value: 0, label: 'フリー練習' },
];

/**
 * How large the table is: the more room around the cars, the easier it is to stay on. The size
 * belongs to the arena, so it is for whoever may change that. A custom arena laid out on a
 * large table may not fit a smaller one; those sizes cannot be chosen.
 */
export function TableSizeField() {
  const stage = useGame((s) => s.stage);
  const canEdit = useGame(canEditArena);
  const options = TABLE_SCALES.map((scale) => ({
    value: scale as number,
    label: scale === 1 ? '標準' : `${scale}倍`,
    disabled: scale !== stage.tableScale && applyArenaEdit(stage, { op: 'table', scale }) === null,
  }));
  return <Segmented label="テーブル" value={stage.tableScale} options={options} onChange={setTableScale} disabled={!canEdit} />;
}

export function RuleFields() {
  const mode = useGame((s) => s.mode);
  const cpuDifficulty = useGame((s) => s.cpuDifficulty);
  const stageId = useGame((s) => s.stage.id);
  const canEdit = useGame(canEditArena);
  const targetScore = useGame((s) => s.targetScore);
  const online = useGame((s) => s.online.status === 'on');
  return (
    <>
      {!online && <Segmented label="モード" value={mode} options={MODES} onChange={(v) => updateSettings({ mode: v })} />}
      {(mode === 'cpu' || online) && (
        <Segmented
          label="CPU"
          value={cpuDifficulty}
          options={DIFFICULTIES}
          onChange={(v) => updateSettings({ cpuDifficulty: v })}
        />
      )}
      <Segmented label="ステージ" value={stageId} options={STAGES} onChange={chooseStage} disabled={!canEdit} />
      <TableSizeField />
      <Segmented label="ルール" value={targetScore} options={TARGETS} onChange={(v) => updateSettings({ targetScore: v })} />
    </>
  );
}
