/* eslint-disable camelcase */
import { ImportPod, ImportPodConfig, ImportPodPlantOpts } from "../basev3";
import { JSONSchemaType } from "ajv";
import { ConflictHandler, PodUtils } from "../utils";
import {
  Conflict,
  DateTime,
  DendronError,
  DEngineClient,
  DNodeUtils,
  DVault,
  ERROR_SEVERITY,
  MergeConflictOptions,
  NoteProps,
  NoteUtils,
  PodConflictResolveOpts,
  stringifyError,
  Time,
} from "@dendronhq/common-all";
import axios from "axios";
import _ from "lodash";
import { FileUtils } from "@dendronhq/common-server";

const ID = "dendron.orbit";

type OrbitMemberData = {
  id: string;
  type: "member";
  attributes: {
    activities_count: number;
    avatar_url: string;
    bio: null | string;
    birthday: null | string;
    company: null | string;
    title: null | string;
    created_at: string;
    deleted_at: null | string;
    first_activity_occurred_at: string;
    last_activity_occurred_at: string;
    location: null | string;
    name: null | string;
    pronouns: null | string;
    reach: number;
    shipping_address: null | string;
    slug: string;
    source: "installation";
    tag_list: [];
    tags: [];
    teammate: false;
    tshirt: null;
    updated_at: string;
    merged_at: null | string;
    url: null | string;
    orbit_url: string;
    created: false;
    id: string;
    orbit_level: number;
    // decimal string
    love: string;
    twitter: null | string;
    github: string;
    discourse: null | string;
    email: null | string;
    devto: null | string;
    linkedin: null | string;
    discord: null | string;
    github_followers: number;
    twitter_followers: null | string;
    topics: null | string;
    languages: null | string;
  };
};

type OrbitImportPodCustomOpts = {
  /**
   * orbit workspace slug
   */
  workspaceSlug: string;
  /**
   * orbit person access token
   */
  token: string;
  /**
   * Single orbit id to import
   */
  orbitId?: string;
  /**
   * If set, always overwrite on conflict
   */
  overwriteAll?: boolean;
};

type OrbitImportPodConfig = ImportPodConfig & OrbitImportPodCustomOpts;

enum SocialKeys {
  github = "github",
  discord = "discord",
  linkedin = "linkedin",
  twitter = "twitter",
  email = "email",
}

type SocialData = Record<SocialKeys, string | null>;
// hn: string | null;
// website: string | null;

type UpdateNotesOpts = {
  note: NoteProps;
  engine: DEngineClient;
  member: OrbitMemberData;
};

export type OrbitImportPodPlantOpts = ImportPodPlantOpts;

class OrbitUtils {
  static getNameFromEmail(email?: string | null): string | undefined {
    if (email) {
      return email.split("@")[0];
    }
    return;
  }

  static getSocialAttributes(member: OrbitMemberData) {
    const keys = Object.values(SocialKeys);
    const out: Partial<SocialData> = {};
    keys.forEach((k) => {
      out[k] = member.attributes[k];
    });
    return out;
  }

  /**
   * Try to get name from social media values, defaulting to orbit id
   * @param param0
   * @returns
   */
  static cleanName({
    id: orbitId,
    attributes: { name, github, discord, twitter, email },
  }: OrbitMemberData) {
    const noteName =
      name ||
      github ||
      discord ||
      twitter ||
      this.getNameFromEmail(email) ||
      orbitId;
    return DNodeUtils.cleanFname(noteName);
  }

  static async getMember({
    token,
    workspaceSlug,
    orbitId,
  }: Required<OrbitImportPodCustomOpts>) {
    const link = `https://app.orbit.love/api/v1/${workspaceSlug}/members/${orbitId}`;
    const headers = {
      Authorization: `Bearer ${token}`,
    };
    const response = await axios.get(link, { headers });
    const member = response.data.data as OrbitMemberData;
    return member;
  }
}

export class OrbitImportPod extends ImportPod<OrbitImportPodConfig> {
  static id: string = ID;
  static description: string = "import orbit workspace members";

  get config(): JSONSchemaType<OrbitImportPodConfig> {
    return PodUtils.createImportConfig({
      required: ["workspaceSlug", "token"],
      properties: {
        token: {
          type: "string",
          description: "orbit personal access token",
        },
        workspaceSlug: {
          type: "string",
          description: "slug of workspace to import from",
        },
        orbitId: {
          type: "string",
          description: "single orbit id to import",
        },
      },
    }) as JSONSchemaType<OrbitImportPodConfig>;
  }

  /**
   * method to fetch all the members for an orbit workspace
   * @param opts
   * @returns members
   */
  getMembersFromOrbit = async (
    opts: OrbitImportPodCustomOpts & { link: string }
  ): Promise<any> => {
    const { token, workspaceSlug } = opts;
    let { link } = opts;
    link =
      link.length > 0
        ? link
        : `https://app.orbit.love/api/v1/${workspaceSlug}/members?items=100`;
    const headers = {
      Authorization: `Bearer ${token}`,
    };
    const members: OrbitMemberData[] = [];
    let next = null;
    try {
      const response = await axios.get(link, { headers });
      response.data.data.forEach((member: OrbitMemberData) => {
        members.push(member);
        next = response.data.links.next;
      });
    } catch (error: any) {
      throw new DendronError({
        message: stringifyError(error),
        severity: ERROR_SEVERITY.MINOR,
      });
    }
    return { members, next };
  };

  /**
   * method to parse members as notes.
   * - creates new noteprops if note is not already there in the vault
   * - writes in a temporary hierarchy if the note is conflicted
   * - updates previously imported notes if there are no conflicts
   */
  async membersToNotes(opts: {
    members: OrbitMemberData[];
    vault: DVault;
    engine: DEngineClient;
    wsRoot: string;
    config: OrbitImportPodConfig;
  }) {
    const ctx = "membersToNotes";
    const { vault, members, engine, wsRoot, config } = opts;
    const conflicts: Conflict[] = [];
    const create: NoteProps[] = [];
    const notesToUpdate: UpdateNotesOpts[] = [];
    members.map((member) => {
      const {
        id: orbitId,
        first_activity_occurred_at,
        last_activity_occurred_at,
        company,
        orbit_level,
        orbit_url,
        reach,
        love,
        slug,
        tag_list,
        shipping_address,
        updated_at,
        activities_count,
        avatar_url,
        birthday,
        location,
        name,
      } = member.attributes;
      const social = OrbitUtils.getSocialAttributes(member);

      const noteName = OrbitUtils.cleanName(member);
      this.L.debug({ ctx, msg: "enter", member });
      let fname;

      // get note
      fname = config.destName ? config.destName : `people.${noteName}`;

      const note = engine.fastMode
        ? FileUtils.getNoteByFile({ fname, vault, wsRoot })
        : NoteUtils.getNoteByFnameV5({
            fname: `people.${noteName}`,
            notes: engine.notes,
            vault,
            wsRoot,
          });

      const orbitData = {
        // TODO: remove
        orbitId,
        social,
        orbit: {
          first_activity_occurred_at,
          last_activity_occurred_at,
          company,
          orbit_level,
          orbit_url,
          reach,
          love,
          slug,
          tag_list,
          shipping_address,
          updated_at,
          activities_count,
          avatar_url,
          birthday,
          location,
          name,
          last_imported_to_dendron: DateTime.now().toISO(),
        },
      };

      // if exists, check if we conflict
      if (!_.isUndefined(note)) {
        this.L.debug({ ctx, state: "getConflictData:pre", msg: "note found" });
        const conflictData = this.getConflictedData({
          note,
          orbitMember: member,
        });
        if (conflictData.length > 0) {
          this.L.debug({ ctx, msg: "conflict found" });
          fname = `people.orbit.duplicate.${Time.now().toFormat(
            "y.MM.dd"
          )}.${noteName}`;
          conflicts.push({
            conflictNote: note,
            conflictEntry: NoteUtils.create({
              fname,
              vault,
              custom: { ...config.frontmatter, ...note.custom, ...orbitData },
              body: note.body,
            }),
            conflictData,
          });
        } else {
          this.L.debug({ ctx, msg: "no conflict found" });
          // if no conflict, we'll update these notes
          notesToUpdate.push({ note, member, engine });
        }
      } else {
        fname = `people.${noteName}`;
        create.push(
          NoteUtils.create({
            fname,
            vault,
            custom: {
              ...config.frontmatter,
              ...orbitData,
            },
          })
        );
      }
    });

    this.L.debug({ ctx, state: "updateNoteData:pre" });
    // update all notes that can be updated
    await Promise.all(
      notesToUpdate.map(({ note, member: social, engine }) => {
        return this.updateNoteData({ note, orbitMember: social, engine });
      })
    );

    return { create, conflicts };
  }

  /**
   * returns all the conflicted entries in custom.social FM field of note
   */
  getConflictedData = (opts: {
    note: NoteProps;
    orbitMember: OrbitMemberData;
  }) => {
    const { note, orbitMember } = opts;

    // look over social keys
    const customKeys = Object.values(SocialKeys);

    // failsave in case social key doesn't exist
    if (!note.custom || !note.custom.social) {
      return [];
    }
    return customKeys.filter((key) => {
      const noteSocialValue = note.custom.social[key];
      return (
        // check that the field is not empty
        _.every([_.isNull, _.isUndefined], (fn) => !fn(noteSocialValue)) &&
        // field is different
        orbitMember.attributes[key] !== note.custom.social[key]
      );
    });
  };

  /**
   * updates the social fields of a note's FM
   */
  updateNoteData = async (opts: {
    note: NoteProps;
    orbitMember: OrbitMemberData;
    engine: DEngineClient;
  }) => {
    const { note, orbitMember, engine } = opts;
    const customKeys = Object.values(SocialKeys);
    const social = orbitMember.attributes;
    let shouldUpdate = false;
    // init if not exist
    if (!note.custom.social) {
      note.custom.social = {};
    }
    customKeys.forEach((key) => {
      if (note.custom?.social[key] === null && social[key] !== null) {
        note.custom.social[key] = social[key];
        shouldUpdate = true;
      }
    });
    // orbit only keys
    if (shouldUpdate) {
      await engine.writeNote(note, { updateExisting: true });
    }
  };

  async onConflict(opts: {
    conflicts: Conflict[];
    index: number;
    config: OrbitImportPodConfig;
    handleConflict: (
      conflict: Conflict,
      conflictResolveOpts: PodConflictResolveOpts
    ) => Promise<string | undefined>;
    engine: DEngineClient;
    conflictResolvedNotes: NoteProps[];
    conflictResolveOpts: PodConflictResolveOpts;
  }): Promise<any> {
    const {
      conflicts,
      handleConflict,
      config,
      engine,
      conflictResolvedNotes,
      conflictResolveOpts,
    } = opts;
    let { index } = opts;
    const conflict = conflicts[index];

    // if overwrite all is set, then don't prompt user
    const resp = config.overwriteAll
      ? MergeConflictOptions.OVERWRITE_LOCAL
      : await handleConflict(conflict, conflictResolveOpts);
    switch (resp) {
      case MergeConflictOptions.OVERWRITE_LOCAL: {
        conflict.conflictEntry.fname = conflict.conflictNote.fname;
        await engine.writeNote(conflict.conflictEntry, {
          updateExisting: true,
        });
        break;
      }
      case MergeConflictOptions.SKIP:
        break;
      case MergeConflictOptions.SKIP_ALL:
        index = conflicts.length;
        break;
      default: {
        break;
      }
    }
    if (index < conflicts.length - 1) {
      return this.onConflict({
        conflicts,
        config,
        engine,
        index: index + 1,
        handleConflict,
        conflictResolvedNotes,
        conflictResolveOpts,
      });
    } else {
      return conflictResolvedNotes;
    }
  }

  validateMergeConflictResponse(choice: number, options: string[]) {
    if (options[choice]) {
      return true;
    } else {
      return "Invalid Choice! Choose 0/1";
    }
  }

  async getSingleMember(
    config: Required<OrbitImportPodCustomOpts> &
      Pick<OrbitImportPodConfig, "overwriteAll">
  ): Promise<OrbitMemberData[]> {
    this.L.info({ ctx: "getSingleMember", state: "enter" });
    return [await OrbitUtils.getMember(config)];
  }

  async getAllMembers({ token, workspaceSlug }: OrbitImportPodConfig) {
    this.L.info({ ctx: "getAllMembers", state: "enter" });
    let next = "";
    let members: OrbitMemberData[] = [];
    while (next !== null) {
      // eslint-disable-next-line no-await-in-loop
      const result = await this.getMembersFromOrbit({
        token,
        workspaceSlug,
        link: next,
      });
      members = [...members, ...result.members];
      next = result.next;
    }
    return members;
  }

  getMergeConflictOptions() {
    return [
      MergeConflictOptions.OVERWRITE_LOCAL,
      MergeConflictOptions.SKIP,
      MergeConflictOptions.SKIP_ALL,
    ];
  }

  getMergeConflictText(conflict: Conflict) {
    let conflictentries = "";
    conflict.conflictData.forEach((key) => {
      conflictentries = conflictentries.concat(
        `\n${key}: \nremote: ${conflict.conflictEntry.custom.social[key]}\nlocal: ${conflict.conflictNote.custom.social[key]}\n`
      );
    });
    return `\nWe noticed different fields for user ${conflict.conflictNote.title} in the note: ${conflict.conflictNote.fname}. ${conflictentries}\n`;
  }

  async plant(opts: OrbitImportPodPlantOpts) {
    const ctx = "OrbitImportPod";
    this.L.info({ ctx, state: "enter" });
    const { vault, config, engine, wsRoot, utilityMethods } = opts;
    const orbitConfig = config as OrbitImportPodConfig;
    const { orbitId } = orbitConfig;

    const members = !_.isUndefined(orbitId)
      ? // required for typescript compiler to know `orbitId` is not undefined
        await this.getSingleMember({ ...orbitConfig, orbitId })
      : await this.getAllMembers(orbitConfig);
    const { create, conflicts } = await this.membersToNotes({
      members,
      vault,
      engine,
      wsRoot,
      config: orbitConfig,
    });
    const conflictNoteArray = conflicts.map(
      (conflict) => conflict.conflictNote
    );
    this.L.debug({
      ctx: "createdAndConflictedNotes",
      created: create.length,
      conflicted: conflicts.length,
    });
    await engine.bulkAddNotes({ notes: create });
    const { handleConflict } = utilityMethods as ConflictHandler;
    const conflictResolveOpts: PodConflictResolveOpts = {
      options: this.getMergeConflictOptions,
      message: this.getMergeConflictText,
      validate: this.validateMergeConflictResponse,
    };
    const conflictResolvedNotes =
      conflicts.length > 0
        ? await this.onConflict({
            conflicts,
            config: orbitConfig,
            handleConflict,
            engine,
            index: 0,
            conflictResolvedNotes: conflictNoteArray,
            conflictResolveOpts,
          })
        : [];
    return { importedNotes: [...create, ...conflictResolvedNotes] };
  }
}
