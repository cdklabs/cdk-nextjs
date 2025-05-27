/**
 * remove below for deprecated relativePathToWorkspace in 0.5.0
 */
export function handleDeprecatedProperties<
  T extends {
    relativePathToWorkspace?: string;
    relativePathToPackage?: string;
  },
>(props: T): T {
  if (props.relativePathToWorkspace) {
    console.warn(
      "WARNING: relativePathToWorkspace is deprecated and will be removed in 0.5.0. Please use relativePathToPackage",
    );
    props.relativePathToPackage = props.relativePathToWorkspace;
  }
  return props;
}
