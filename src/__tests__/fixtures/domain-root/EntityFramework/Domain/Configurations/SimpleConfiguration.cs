using TrainerRoad.Server.Domain;

namespace TrainerRoad.Server.EntityFramework.Domain.Configurations
{
    public class ActivityConfiguration : BaseEntityTypeConfiguration<Activity>
    {
        public ActivityConfiguration()
        {
            ToTable("Activity");
            HasKey(x => x.Id);

            HasRequired(x => x.Member)
                .WithMany(x => x.Activities)
                .HasForeignKey(x => x.MemberId);

            HasRequired(x => x.CyclingActivity)
                .WithRequiredPrincipal(x => x.Activity);

            HasOptional(x => x.Workout)
                .WithMany(w => w.Activities)
                .HasForeignKey(x => x.WorkoutId);
        }
    }
}
