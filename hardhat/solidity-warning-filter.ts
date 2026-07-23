import type { SolidityHooks } from "hardhat/types/hooks";

const UNUSED_FUNCTION_PARAMETER_ERROR_CODE = "5667";
const UNUSED_FUNCTION_PARAMETER_MESSAGE = "Unused function parameter.";

type CompilerWarning = {
  errorCode?: string;
  formattedMessage?: string;
  message: string;
  severity: "error" | "warning" | "info";
  sourceLocation?: {
    file?: string;
  };
};

function warningMessage(error: CompilerWarning): string {
  return error.formattedMessage ?? error.message;
}

function isUnusedParameterWarning(error: CompilerWarning): boolean {
  return (
    error.errorCode === UNUSED_FUNCTION_PARAMETER_ERROR_CODE ||
    warningMessage(error).includes(UNUSED_FUNCTION_PARAMETER_MESSAGE)
  );
}

function isDependencyPath(sourcePath: string): boolean {
  return (
    sourcePath.includes("node_modules/") ||
    sourcePath.startsWith("npm:") ||
    sourcePath.startsWith("@") ||
    sourcePath.startsWith("hardhat/")
  );
}

function isDependencyWarning(error: CompilerWarning): boolean {
  const message = warningMessage(error);

  if (error.sourceLocation?.file !== undefined && isDependencyPath(error.sourceLocation.file)) return true;

  const sourceMatch = message.match(/-->\s+([^\s:]+\.sol)/);
  if (sourceMatch === null) return false;

  return isDependencyPath(sourceMatch[1]);
}

export default async (): Promise<Partial<SolidityHooks>> => ({
  getCompilationJobErrors: async (context, compilationJob, compilerOutput, next) => {
    const errors = await next(context, compilationJob, compilerOutput);

    return errors.filter(
      (error) => !(error.severity === "warning" && (isUnusedParameterWarning(error) || isDependencyWarning(error))),
    );
  },
});
