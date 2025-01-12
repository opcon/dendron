import { Logger } from "../logger";
import { DENDRON_COMMANDS } from "../constants";
import { BasicCommand } from "./base";
import {
  CommandOutput as NoteLookupOutput,
  CommandRunOpts as NoteLookupRunOpts,
} from "./NoteLookupCommand";
import { AutoCompletableRegistrar } from "../utils/registers/AutoCompletableRegistrar";
import { LookupNoteTypeEnum } from "../components/lookup/types";

type CommandOpts = NoteLookupRunOpts;
type CommandOutput = NoteLookupOutput | undefined;

export { CommandOpts as LookupJournalNoteOpts };

export class LookupJournalNoteCommand extends BasicCommand<
  CommandOpts,
  CommandOutput
> {
  key = DENDRON_COMMANDS.LOOKUP_JOURNAL.key;

  async execute(opts: CommandOpts) {
    const ctx = "LookupJournalNote";
    Logger.info({ ctx, msg: "enter", opts });
    const noteLookupRunOpts = {
      ...opts,
      noteType: LookupNoteTypeEnum.journal,
    } as NoteLookupRunOpts;
    return AutoCompletableRegistrar.getNoteLookupCmd().run(noteLookupRunOpts);
  }
}
