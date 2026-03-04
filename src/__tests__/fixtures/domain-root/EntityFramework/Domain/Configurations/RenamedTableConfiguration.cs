using TrainerRoad.Server.Domain;

namespace TrainerRoad.Server.EntityFramework.Domain.Configurations
{
    public class WorkoutRecordConfiguration : BaseEntityTypeConfiguration<WorkoutRecord>
    {
        public WorkoutRecordConfiguration()
        {
            ToTable("CyclingActivity");
            HasKey(x => x.Id);

            Property(x => x.ExclusionStatus).HasDatabaseGeneratedOption(DatabaseGeneratedOption.Computed);

            HasMany(x => x.Followers)
                .WithMany(x => x.FollowedWorkoutRecords)
                .Map(x => x.ToTable("ActivityFollower").MapLeftKey("ActivityId").MapRightKey("MemberId"));
        }
    }
}
